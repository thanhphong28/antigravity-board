import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Antigravity Board', version: '1.0.0' }, {});

function syncTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme');
    if (btn) btn.setAttribute('data-choice', theme);
  }
}

// Register handlers before connect() so no initial notification is missed.
app.ontoolinput = () => {};
app.ontoolresult = (result) => {
  const data = result?.structuredContent;
  if (data && Array.isArray(data.tasks) && typeof window.__agBoardSetData === 'function') {
    window.__agBoardSetData(data);
  }
};
app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) syncTheme(ctx.theme);
};

async function init() {
  try {
    await app.connect();
    const ctx = app.getHostContext();
    if (ctx?.theme) syncTheme(ctx.theme);

    const actions = document.querySelector('.top .actions');
    if (actions && !document.getElementById('ag-sync')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'ag-sync';
      btn.className = 'btn';
      btn.textContent = 'Sync';
      btn.title = 'Resync all Antigravity App, IDE & CLI sessions';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Syncing...';
        try {
          const res = await app.callServerTool({ name: 'sync_antigravity_board', arguments: {} });
          const data = res?.structuredContent;
          if (data && Array.isArray(data.tasks) && typeof window.__agBoardSetData === 'function') {
            window.__agBoardSetData(data);
          }
        } catch (err) {
          console.error('[antigravity-board] Sync failed:', err);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Sync';
        }
      });
      actions.appendChild(btn);
    }
  } catch (err) {
    console.error('[antigravity-board] MCP App connect error:', err);
  }
}

init();
