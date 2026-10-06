/**
 * Where the sign-in popup lands once Google, GitHub or Apple has finished. The
 * tokens are in the address (after the #); this page hands the address to the
 * service worker, which completes the sign-in and closes the window.
 */
const title = document.getElementById('title')!;
const note = document.getElementById('note')!;

chrome.runtime.sendMessage({ type: 'fillie:auth-callback', url: location.href }, () => {
  if (chrome.runtime.lastError) {
    title.textContent = 'Could not finish signing in';
    note.textContent = 'Close this window and try again.';
    return;
  }
  title.textContent = 'You are signed in';
  window.close();
});
