
/**
 * SFT App Shell: persistent top nav + roster table retrofit
 * Include on every page: <script src="/app-shell.js" defer></script>
 */
(function(){
  function ensureStyles() {
    if (!document.querySelector('link[href="/styles.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/styles.css';
      document.head.appendChild(link);
    }
  }

  function createHeader() {
    const header = document.createElement('header');
    header.className = 'site-nav';
    header.innerHTML = [
      '<div class="nav-inner">',
      '  <div class="nav-left brand"><span>SFT</span><span class="accent">Dashboard</span></div>',
      '  <nav class="nav-center nav-links" aria-label="Primary">',
      '    <a href="/roster/overview" class="nav-link">Roster</a>',
      '    <a href="/attacks" class="nav-link">Attack Logs</a>',
      '    <a href="/manage" class="nav-link">Management</a>',
      '  </nav>',
      '  <div class="nav-right"></div>',
      '</div>'
    ].join('');
    return header;
  }

  function ensureHeader() {
  if (location.pathname === '/') return;
  if (location.pathname === '/') return;
    if (document.querySelector('.site-nav')) return;
    const header = createHeader();
    document.body.insertBefore(header, document.body.firstChild);
  }

  function markActiveLink() {
    const here = location.pathname.replace(/\/+$/,'') || '/';
    document.querySelectorAll('.nav-link').forEach(a => {
      const path = (a.getAttribute('href')||'').replace(/\/+$/,'') || '/';
      if (path === here) a.classList.add('active');
    });
  }

  function retrofitRosterTable() {
    const t = document.querySelector('main table, #app table, table');
    if (!t) return;
    if (!t.classList.contains('roster-overview')) t.classList.add('roster-overview');
    if (!t.closest('.roster-container')) {
      const wrap = document.createElement('div');
      wrap.className = 'roster-container';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    }
  }

  // Run after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init(){
    ensureStyles();
    ensureHeader();
    markActiveLink();
    retrofitRosterTable();
  }
})();
