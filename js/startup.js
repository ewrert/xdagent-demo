/** 启动反馈独立于 Vue，在关键脚本失败时保留可用的重试入口。 */
(() => {
  let state = 'loading';

  function render() {
    const startup = document.getElementById('app-startup');
    if (!startup) return;
    startup.hidden = state === 'ready';
    if (state === 'failed') {
      document.getElementById('app-startup-message').textContent = '页面加载失败，请重新加载后重试。';
      document.getElementById('app-startup-retry').hidden = false;
    }
  }

  function fail() {
    if (state === 'ready') return;
    state = 'failed';
    clearTimeout(deadline);
    render();
  }

  function ready() {
    state = 'ready';
    clearTimeout(deadline);
    window.removeEventListener('error', onError, true);
    render();
  }

  function onError(event) {
    if (event.target instanceof HTMLScriptElement || event instanceof ErrorEvent) fail();
  }

  const deadline = setTimeout(fail, 12000);
  window.AppStartup = { ready };
  window.addEventListener('error', onError, true);
  document.addEventListener('DOMContentLoaded', render, { once: true });
})();
