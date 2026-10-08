import { bellArt, folderArt, handArt, heartArt, keyArt, resumeArt, sized, sparkArt } from '../ui/art';
import type { TourStep } from '../ui/tour';

/** Short words, one big picture per step. The welcome tour walks through the whole extension in about a minute. */
export function welcomeSteps(): TourStep[] {
  return [
    { id: 'hello', art: sized(sparkArt, 104), title: 'Hi, I’m Fillie!', text: 'I fill job forms for you. Want a quick tour? It takes one minute.', button: 'Show me' },
    { id: 'profile', art: sized(resumeArt, 104), title: 'Tell me about you', text: 'Add your details once. I use them on every form.', target: '[data-nav="#/profile/personal"]', route: '#/profile/personal' },
    { id: 'resumes', art: sized(folderArt, 104), title: 'One resume per role', text: 'Add your resumes here. I pick the best one for each job.', target: '[data-nav="#/resume"]', route: '#/resume' },
    { id: 'ai', art: sized(keyArt, 104), title: 'Add a free AI key', text: 'Then I can write answers to open questions. Gemini takes a minute.', target: '[data-nav="#/settings/ai"]', route: '#/settings/ai' },
    { id: 'fill', art: sized(sparkArt, 104), title: 'Open any job form', text: 'Press these keys on the page. I fill it in seconds.', keys: ['Alt', 'Shift', 'F'], route: '#/database' },
    { id: 'heart', demo: 'heart', title: 'Tap the heart', text: 'See a great answer? Tap its heart to keep it for your interview.' },
    { id: 'database', art: sized(heartArt, 104), title: 'Every form lands here', text: 'AI adds notes. Tap “Interview prep” on a card to read your saved answers.', target: '[data-nav="#/database"]', route: '#/database' },
    { id: 'reminders', art: sized(bellArt, 104), title: 'Never miss an interview', text: 'Set a date on a card. I remind you a day before, and an hour before.' },
    { id: 'account', art: sized(handArt, 104), title: '3 free fills every week', text: 'Want more? Unlock once. No subscription. You always press submit.', target: '[data-nav="#/account"]', route: '#/account' },
    { id: 'done', art: sized(sparkArt, 104), title: 'You’re ready!', text: 'Open a job form and press Alt + Shift + F.', button: 'Let’s go' },
  ];
}

/** One-time tips, shown the first time a section is opened. */
export const SECTION_TIPS: Record<string, TourStep> = {
  profile: { id: 'tip-profile', art: sized(resumeArt, 78), title: 'Your profile', text: 'The more you add, the fewer blanks on forms.' },
  resume: { id: 'tip-resume', art: sized(folderArt, 78), title: 'Resumes', text: 'Add one per role. I suggest the best match each time.' },
  ai: { id: 'tip-ai', art: sized(keyArt, 78), title: 'AI keys', text: 'Paste a free key. If one runs out, I use the next.' },
  database: { id: 'tip-database', art: sized(heartArt, 78), title: 'Your applications', text: 'Tap “Interview prep” on a card to read the answers you saved.' },
  memory: { id: 'tip-memory', art: sized(sparkArt, 78), title: 'What I remember', text: 'Answers you approve are reused on the next form.' },
  account: { id: 'tip-account', art: sized(handArt, 78), title: 'Plan and sign-in', text: 'Sign in to back up and unlock unlimited fills.' },
  privacy: { id: 'tip-privacy', art: sized(bellArt, 78), title: 'Interview reminders', text: 'Switch them on or off here. I never submit a form for you.' },
};

/** Which tip belongs to a page, if any. */
export function tipKeyFor(route: { kind: string; section?: string }): string | undefined {
  if (route.kind === 'settings') return route.section === 'ai' ? 'ai' : route.section === 'privacy' ? 'privacy' : undefined;
  return route.kind in SECTION_TIPS ? route.kind : undefined;
}
