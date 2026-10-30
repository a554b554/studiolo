// Desktop notifications for new results: a conversation finished, failed or waits for
// an answer while the window is in the background. In the Tauri client they go through its
// notification plugin; in a browser only when the user already allowed notifications.
const seen = new Set();
let primed = false;

export function notifyResults(projects, unreadOf, describe) {
  const fresh = [];
  for (const project of projects) for (const [sessionId, mark] of Object.entries(unreadOf(project))) {
    const key = `${project.id}:${sessionId}:${mark.at}`;
    if (!seen.has(key)) { seen.add(key); fresh.push({ project, mark }); }
  }
  // Marks already present when the page opens were seen in the list, not just now.
  if (!primed) { primed = true; return; }
  if (!document.hidden && document.hasFocus()) return;
  for (const { project, mark } of fresh) send(project.name, describe(mark));
}

async function send(title, body) {
  try {
    const plugin = window.__TAURI__?.notification;
    if (plugin) {
      if (!(await plugin.isPermissionGranted()) && (await plugin.requestPermission()) !== 'granted') return;
      plugin.sendNotification({ title, body });
    } else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
  } catch {}
}
