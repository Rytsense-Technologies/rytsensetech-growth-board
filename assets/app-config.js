/* Public client config. The publishable/anon key is meant for the browser.
   Never put SUPABASE_SERVICE_ROLE_KEY or CRON_SECRET here. */
(function () {
  var local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname);
  window.GB_CONFIG = {
    supabaseUrl: 'https://rjcsvypaxasbtsdtklde.supabase.co',
    supabaseAnonKey: 'sb_publishable_PhEHrwBjIJkQS0RFc3oaPQ_PO4WM0rA',
    apiBase: local ? 'http://localhost:8787' : 'https://rytsensetech-growth-board.onrender.com',
  };
})();
