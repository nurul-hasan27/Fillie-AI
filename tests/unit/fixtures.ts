import type { DetectedField, UserProfile } from '../../src/core/types';

/** Builds a filled-in profile used across the engine tests. Never a hardcoded
 *  user in the product — only a fixture. */
export function testProfile(): UserProfile {
  return {
    personal: {
      fullName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+44 20 7946 0000',
      location: 'London, United Kingdom',
      address: '12 Marylebone Road',
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
      college: 'King’s College London',
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
        challenges: 'Offline sync without battery drain.',
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
      {
        id: 'ach-2',
        type: 'certification',
        title: 'AWS Certified Developer – Associate',
        organisation: 'Amazon Web Services',
        date: '2024-02',
        credentialId: 'AWS-123456',
      },
    ],
    links: {
      linkedin: 'https://linkedin.com/in/ada',
      github: 'https://github.com/ada',
      portfolio: 'https://ada.example.com',
      other: ['https://dev.to/ada'],
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
}

let counter = 0;

export function field(overrides: Partial<DetectedField> = {}): DetectedField {
  counter += 1;
  return {
    id: `t${counter}`,
    kind: 'text',
    label: 'Question',
    required: false,
    disabled: false,
    visible: true,
    source: 'native',
    fingerprint: 'question',
    ...overrides,
  };
}

export function context(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://jobs.example.com/apply/42',
    host: 'jobs.example.com',
    pageTitle: 'Backend Engineer at Northwind',
    company: 'Northwind',
    role: 'Backend Engineer',
    location: 'London, UK',
    jobDescription:
      'About the role: You will build distributed services in Go and Python. Requirements: 2+ years backend experience, PostgreSQL, Kubernetes.',
    detectedAt: Date.now(),
    ...overrides,
  };
}

export function setHtml(html: string): void {
  document.body.innerHTML = html;
}