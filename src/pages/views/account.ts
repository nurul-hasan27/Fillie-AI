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

function signIn(state: AccountState): TemplateResult {
  const signup = state.mode === 'signup';
  return html`
    <section class="ff-card">
      <div class="card-pad-lg stack-md">
        <h2 class="ff-title">${signup ? 'Create your account' : 'Sign in'}</h2>
        <div class="oauth-row">
          <button class="ff-btn ff-btn-secondary" type="button" data-action="oauth" data-provider="google" ${state.busy ? 'disabled' : ''}>Google</button>
          <button class="ff-btn ff-btn-secondary" type="button" data-action="oauth" data-provider="github" ${state.busy ? 'disabled' : ''}>GitHub</button>
          <button class="ff-btn ff-btn-secondary" type="button" data-action="oauth" data-provider="apple" ${state.busy ? 'disabled' : ''}>Apple</button>
        </div>
        <p class="ff-meta" style="text-align:center">or use your email</p>
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
