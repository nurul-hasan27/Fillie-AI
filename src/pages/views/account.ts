import type { AccountStatus } from '../../shared/messages';
import { formatRelativeTime } from '../../core/text';
import { escapeHtml, html, type TemplateResult } from '../../ui/dom';
import { banner, sectionIntro } from '../controls';

/** Account page: plan, sign-in, and cloud backup. */

export interface AccountState {
  status: AccountStatus | null;
  mode: 'signin' | 'signup';
  busy: string;
  feedbackRating: number;
  message?: { tone: 'info' | 'danger'; text: string };
}

function planCard(status: AccountStatus): TemplateResult {
  const { access, priceLabel } = status;
  if (access.plan === 'paid' && status.cloudConfigured) {
    return html`
      <div class="hero-card" data-tone="midnight">
        <div class="hero-copy">
          <h2>Fillie is yours</h2>
          <p>Unlimited form filling, tracker and backup. Thank you for supporting Fillie.</p>
          <span class="hero-pill">Unlocked</span>
        </div>
      </div>
    `;
  }
  const left = access.remaining;
  const dots = Array.from({ length: access.limit }, (_, i) => html`<i class="${i < left ? 'on' : ''}"></i>`);
  return html`
    <div class="hero-card" data-tone="marigold">
      <div class="hero-copy">
        <h2>${left > 0 ? `${left} free ${left === 1 ? 'filling' : 'fillings'} left this week` : 'Free fillings used up'}</h2>
        <p>Every week you get ${access.limit} free form fillings. Unlock Fillie once for ${escapeHtml(priceLabel)} and fill as many as you like.</p>
        <div class="dots" aria-hidden="true">${dots}</div>
        <div class="row-wrap" style="margin-top:14px">
          ${access.signedIn
            ? html`<button class="ff-btn ff-btn-primary ff-btn-lg" type="button" data-action="checkout" data-provider="stripe" ${status.cloudConfigured ? '' : 'disabled'}>Pay ${escapeHtml(priceLabel.replace(' one-time', ''))} by card</button>
                   <button class="ff-btn ff-btn-secondary ff-btn-lg" type="button" data-action="checkout" data-provider="razorpay" ${status.cloudConfigured ? '' : 'disabled'}>UPI / cards · ${escapeHtml(status.razorpayLabel)}</button>
                   <button class="ff-btn ff-btn-ghost" type="button" data-action="refresh-payment">I have paid</button>`
            : html`<span class="hero-pill">Sign in below to unlock</span>`}
        </div>
      </div>
    </div>
  `;
}

const BRANDS = {
  google: {
    label: 'Google',
    icon: `<svg viewBox="0 0 18 18" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2045c0-.638-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.859-3.0477.859-2.3441 0-4.3282-1.5831-5.0359-3.7104H.9574v2.3318C2.4382 15.9832 5.4818 18 9 18z"/><path fill="#FBBC05" d="M3.9641 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.9641 10.71z"/><path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9641 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z"/></svg>`,
  },
  github: {
    label: 'GitHub',
    icon: `<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
  },
  apple: {
    label: 'Apple',
    icon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>`,
  },
};

/** A provider sign-in button that looks like the provider's own: logo, brand colours, full width. */
function oauthButton(provider: keyof typeof BRANDS, signup: boolean, busy: string): TemplateResult {
  const brand = BRANDS[provider];
  return html`
    <button class="oauth-btn oauth-${provider}" type="button" data-action="oauth" data-provider="${provider}" ${busy ? 'disabled' : ''}>
      <span class="oauth-logo">${brand.icon}</span>
      <span class="oauth-label">${signup ? 'Sign up' : 'Continue'} with ${brand.label}</span>
    </button>
  `;
}

function signIn(state: AccountState): TemplateResult {
  const signup = state.mode === 'signup';
  return html`
    <section class="ff-card">
      <div class="card-pad-lg stack-md">
        <h2 class="ff-title">${signup ? 'Create your account' : 'Sign in'}</h2>
        <div class="oauth-list" role="group" aria-label="Sign in with">
          ${(['google', 'github', 'apple'] as const).map((provider) => oauthButton(provider, signup, state.busy))}
        </div>
        ${state.busy === 'oauth' ? html`<p class="oauth-hint" role="status">Finish signing in in the window that opened. It closes by itself.</p>` : ''}
        <div class="or-divider"><span>or use your email</span></div>
        <form id="auth-form" class="stack-md" autocomplete="on">
          <div class="ff-field"><label class="ff-field-label" for="auth-email">Email</label>
            <input class="ff-input" id="auth-email" type="email" autocomplete="email" required /></div>
          <div class="ff-field"><label class="ff-field-label" for="auth-password">Password</label>
            <input class="ff-input" id="auth-password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required /></div>
          <div class="row-wrap">
            <button class="ff-btn ff-btn-primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy === 'password' ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
            <button class="ff-btn ff-btn-ghost" type="button" data-action="toggle-auth">${signup ? 'I already have an account' : 'Create an account'}</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function signedIn(status: AccountStatus): TemplateResult {
  return html`
    <section class="ff-card">
      <div class="card-pad-lg stack-md">
        <div class="ff-row-between">
          <div><h2 class="ff-title">Signed in</h2><p class="ff-meta">${escapeHtml(status.access.email ?? '')}</p></div>
          <button class="ff-btn ff-btn-secondary" type="button" data-action="sign-out">Sign out</button>
        </div>
      </div>
    </section>
    <section class="ff-card">
      <div class="card-pad-lg stack-md">
        <h2 class="ff-title">Cloud backup</h2>
        <p class="ff-body ff-secondary">Your profile, resumes and learned answers are backed up automatically. API keys never leave this device. If this browser's data is cleared, Fillie restores your backup the next time you fill a form.</p>
        <p class="ff-meta">${status.lastBackupAt ? `Last backup ${escapeHtml(formatRelativeTime(status.lastBackupAt))}` : 'No backup yet.'}${status.pendingApplications ? ` · ${status.pendingApplications} application${status.pendingApplications > 1 ? 's' : ''} waiting to upload` : ''}</p>
        <div class="row-wrap">
          <button class="ff-btn ff-btn-secondary" type="button" data-action="backup-now">Back up now</button>
          <button class="ff-btn ff-btn-ghost" type="button" data-action="restore-now">Restore from backup</button>
        </div>
      </div>
    </section>
    <section class="ff-card">
      <div class="card-pad-lg stack-md">
        <h2 class="ff-title">Got an offer?</h2>
        <label class="ff-switch">
          <input type="checkbox" data-action="toggle-share-offers" ${status.shareOffers ? 'checked' : ''} />
          <span class="ff-switch-track"><span class="ff-switch-thumb"></span></span>
          <span class="ff-body">Let Fillie share my offers (company, role, package) as success stories, with my email visible to the Fillie team.</span>
        </label>
        <p class="ff-hint">Off by default. Without this, your offers only count in anonymous totals.</p>
      </div>
    </section>
  `;
}

function feedbackCard(state: AccountState): TemplateResult {
  return html`
    <section class="ff-card">
      <div class="card-pad-lg stack-md">
        <h2 class="ff-title">Rate Fillie</h2>
        <div class="stars" role="group" aria-label="Your rating">
          ${[1, 2, 3, 4, 5].map((n) => html`<button class="star" type="button" data-action="feedback-star" data-value="${n}" data-on="${String(state.feedbackRating >= n)}" aria-label="${n} star${n > 1 ? 's' : ''}" style="font-size:26px">★</button>`)}
        </div>
        <div class="ff-field"><label class="ff-field-label" for="fb-kind">About</label>
          <select class="ff-select" id="fb-kind"><option value="review">A review</option><option value="bug">A bug</option><option value="idea">An idea</option></select></div>
        <div class="ff-field"><label class="ff-field-label" for="fb-message">What do you think?</label>
          <textarea class="ff-textarea" id="fb-message" rows="3" maxlength="2000" placeholder="What worked, what did not…"></textarea></div>
        <div class="row-wrap"><button class="ff-btn ff-btn-primary" type="button" data-action="send-feedback">Send feedback</button></div>
      </div>
    </section>
  `;
}

export function accountView(state: AccountState): TemplateResult {
  const status = state.status;
  return html`
    ${sectionIntro('Account', 'Your plan, sign-in and backup.')}
    ${state.message ? banner({ tone: state.message.tone, title: state.message.text }) : ''}
    ${!status
      ? html`<div class="db-empty"><span class="ff-spinner"></span></div>`
      : html`
          ${status.cloudConfigured ? '' : banner({ tone: 'warning', title: 'Cloud is not set up', body: 'This is a development build, so Fillie is unlimited and sign-in is off. Add your Supabase keys in src/core/cloud/config.ts.' })}
          ${planCard(status)}
          ${status.access.signedIn ? html`${signedIn(status)}${feedbackCard(state)}` : status.cloudConfigured ? signIn(state) : ''}
        `}
  `;
}
