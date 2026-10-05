import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserProfile } from '../../src/core/types';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(root, 'dist');

export const EXTENSION_ID = 'fillie-e2e';

/** Fixtures are deterministic and never contain real personal data. */
export const PROFILE: UserProfile = {
  personal: {
    fullName: 'Ada Lovelace',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '+44 20 7946 0000',
    location: 'London, United Kingdom',
    address: '12 Marylebone Road, London',
    city: 'London',
    state: 'Greater London',
    country: 'United Kingdom',
    postalCode: 'NW1 5LA',
    dateOfBirth: '1999-12-10',
    nationality: 'British',
    gender: 'Female',
    languages: ['English (fluent)', 'French (conversational)'],
  },
  education: {
    university: 'University of London',
    college: "King's College London",
    degree: 'BSc',
    branch: 'Computer Science',
    specialization: 'Distributed Systems',
    graduationYear: '2021',
    currentSemester: '',
    cgpa: '8.6',
    percentage: '82',
    schoolName: 'Northgate High School',
    board: 'CBSE',
    coursework: ['Data Structures', 'Operating Systems', 'Distributed Systems', 'Databases'],
  },
  skills: {
    programmingLanguages: ['Python', 'TypeScript', 'Go'],
    frameworks: ['React', 'Django', 'FastAPI'],
    databases: ['PostgreSQL', 'MongoDB', 'Redis'],
    cloud: ['AWS', 'Docker'],
    tools: ['Git', 'Figma', 'Jira'],
    technologies: ['Kafka', 'GraphQL'],
    softSkills: ['Mentoring', 'Technical writing'],
  },
  experience: [
    {
      id: 'exp-1',
      type: 'internship',
      organisation: 'Meridian Analytics',
      role: 'Backend Engineering Intern',
      location: 'London',
      startDate: '2020-06',
      endDate: '2020-12',
      responsibilities: [
        'Rebuilt the ingestion API in Python, cutting p95 latency from 900ms to 180ms.',
        'Added contract tests covering 42 endpoints.',
      ],
      achievements: ['Reduced infrastructure spend by 18% by batching writes'],
    },
  ],
  projects: [
    {
      id: 'proj-1',
      name: 'Trailhead',
      description: 'A campus navigation app that routes students between buildings.',
      problem: 'New students struggled to find lecture halls between buildings.',
      solution: 'Built an indoor wayfinding app with an offline map and crowd-sourced routes.',
      technologies: ['React', 'TypeScript', 'Node', 'PostgreSQL'],
      contribution: 'Led a team of four and wrote the routing engine.',
      challenges: 'Offline sync without draining the battery.',
      results: 'Used by 4,200 students in the pilot term.',
      metrics: '4.2k users, p95 180ms',
      github: 'https://github.com/example/trailhead',
      demo: 'https://trailhead.example.com',
      teamSize: '4',
      leadership: 'Team lead',
    },
  ],
  achievements: [
    {
      id: 'ach-1',
      type: 'award',
      title: 'Winner — National Engineering Hackathon 2023',
      organisation: 'HackNation',
      date: '2023-11',
      detail: 'First place of 240 teams for an accessibility-focused project.',
      url: 'https://example.com/award',
    },
  ],
  links: {
    linkedin: 'https://linkedin.com/in/ada',
    github: 'https://github.com/ada',
    portfolio: 'https://ada.example.com',
    other: [],
  },
  preferences: {
    willingToRelocate: 'Yes',
    preferredLocations: ['London', 'Remote (EU)'],
    workMode: 'Hybrid',
    availability: 'Immediately',
    noticePeriod: '30 days',
    salaryExpectation: '£75,000',
    currency: 'GBP',
  },
  updatedAt: Date.now(),
  version: 1,
};

export interface AiOverrides {
  enabled: boolean;
  /** Shorthand: appends the scenario to the local mock base URL. */
  scenario?: 'valid' | 'hostile' | 'nonsense' | 'hallucinated' | 'rate-limit' | 'fail' | 'slow';
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  batchSize?: number;
  maxRetries?: number;
  autoFillThreshold?: number;
  reviewThreshold?: number;
}

export interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  /** A background tab on the extension's own page, used to drive chrome APIs. */
  control: Page;
  open(url: string): Promise<Page>;
  seedProfile(profile?: Partial<UserProfile>): Promise<void>;
  setAi(overrides: AiOverrides): Promise<void>;
  sendToWorker<T>(message: unknown): Promise<T>;
  close(): Promise<void>;
}

/** Local stand-in for a hosted provider; the scenario is chosen by path. */
export const MOCK_AI = 'http://127.0.0.1:4321/mock-ai';

export const test = base.extend<{ fillie: Fixtures }>({
  fillie: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });

    const extensionId = new URL(serviceWorker.url()).host;

    // Extension APIs are only fully available on an extension page, so the
    // tests talk to Fillie the way its own UI does.
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/pages/app.html`, { waitUntil: 'domcontentloaded' });

    // Each fixture page gets a unique query string so tests can drive a specific
    // tab even when two fixtures share the same path.
    let openCounter = 0;
    const open = async (url: string): Promise<Page> => {
      openCounter += 1;
      const page = await context.newPage();
      const separator = url.includes('?') ? '&' : '?';
      await page.goto(`${url}${separator}tab=${openCounter}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(250);
      return page;
    };

    const sendToWorker = async <T>(message: unknown): Promise<T> => {
      const response = await control.evaluate(
        (payload) =>
          new Promise<unknown>((resolve, reject) => {
            chrome.runtime.sendMessage(payload, (result: unknown) => {
              const error = chrome.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve(result);
            });
          }),
        message,
      );
      return response as T;
    };

    const seedProfile = async (profile: Partial<UserProfile> = {}): Promise<void> => {
      await sendToWorker({ type: 'fillie:save-profile', profile: { ...PROFILE, ...profile } });
      await sendToWorker({ type: 'fillie:save-memory', memory: [] });
      // Every test starts fully offline, so the suite is hermetic and no test
      // can ever reach a real provider.
      await setAi({ enabled: false });
    };

    /**
     * Points the extension at a provider. Defaults to the local mock endpoint,
     * so passing only a scenario name is enough.
     */
    const setAi = async (overrides: AiOverrides): Promise<void> => {
      const base = {
        enabled: true,
        config: {
          provider: 'openai-compatible' as const,
          model: 'mock-model',
          baseUrl: `${MOCK_AI}/valid/v1`,
          // A fake key: it only ever travels to the local mock server.
          apiKey: 'mock-key',
          temperature: 0.2,
          maxOutputTokens: 800,
          timeoutMs: 8000,
          jsonMode: true,
        },
        batchSize: 8,
        // Fail fast in tests; the retry logic itself is unit tested.
        maxRetries: 0,
        autoFillThreshold: 0.82,
        reviewThreshold: 0.62,
      };
      const { enabled, scenario, provider, baseUrl, model, apiKey, ...rest } = overrides;
      await sendToWorker({
        type: 'fillie:save-settings',
        settings: {
          ...base,
          ...rest,
          enabled: enabled ?? base.enabled,
          config: {
            ...base.config,
            ...(scenario ? { baseUrl: `${MOCK_AI}/${scenario}/v1` } : {}),
            ...(provider ? { provider } : {}),
            ...(baseUrl ? { baseUrl } : {}),
            ...(model ? { model } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
        },
      });
    };

    await seedProfile();

    await use({ context, extensionId, serviceWorker, control, open, seedProfile, setAi, sendToWorker, close: () => context.close() });

    await context.close();
  },
});

export { expect } from '@playwright/test';

/**
 * Runs the assistant on a tab, exactly as the popup button does: a message to
 * the content script via the extension's tabs API.
 */
export async function runFillieOn(page: Page, fixtures: Fixtures): Promise<void> {
  const url = page.url();
  await fixtures.control.evaluate(async (target: string) => {
    const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => chrome.tabs.query({}, resolve));
    const tab = tabs.find((candidate) => candidate.url === target) ?? tabs.find((candidate) => candidate.active);
    if (tab?.id === undefined) throw new Error(`No tab found for ${target}`);
    await new Promise<void>((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id as number, { type: 'fillie:run' }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }, url);
}

/** Waits for the assistant panel to appear inside its shadow root. */
export async function waitForPanel(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const host = document.querySelector('[data-fillie-panel="true"]');
      return Boolean(host?.shadowRoot?.querySelector('.panel'));
    },
    undefined,
    { timeout },
  );
}

/**
 * Locators for the assistant panel. Playwright's locators pierce open shadow
 * roots automatically, so `[data-fillie-panel] .task` resolves inside it.
 */
export function panel(page: Page) {
  return page.locator('[data-fillie-panel="true"]');
}
/**
 * Waits until the assistant has finished scanning and rendered results — not the
 * scanning state and not an error state.
 */
export async function waitForResults(page: Page, timeout = 30_000): Promise<void> {
  await waitForPanel(page, timeout);
  await page.waitForFunction(
    () => {
      const root = document.querySelector('[data-fillie-panel="true"]')?.shadowRoot;
      const panelEl = root?.querySelector('.panel');
      if (!panelEl) return false;
      return !panelEl.querySelector('.scan') && !panelEl.querySelector('.notice[data-tone="danger"]');
    },
    undefined,
    { timeout },
  );
}
