/* ============================================================
   TAOSCAN PRO — app.js (Complete Version)
   Handles UI events, modal toggles, and safe telemetry fetching
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  
  // ── DOM ELEMENT HOOKS ──
  const runScanBtn = document.getElementById('runScanBtn');
  const scannerResults = document.getElementById('scannerResults');
  const scannerStatusBox = document.getElementById('scannerStatusBox');
  const statusMessage = document.getElementById('statusMessage');
  
  const settingsBtn = document.getElementById('settingsBtn');
  const configModal = document.getElementById('configModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const closeModalBtn2 = document.getElementById('closeModalBtn2');

  const activeSymbol = document.getElementById('activeSymbol');
  const activePrice = document.getElementById('activePrice');
  const matrixRsi = document.getElementById('matrixRsi');
  const matrixMacd = document.getElementById('matrixMacd');

  // ── CONFIGURATION MODAL INTERACTION ──
  if (settingsBtn && configModal) {
    settingsBtn.addEventListener('click', () => configModal.classList.add('open'));
  }

  [closeModalBtn, closeModalBtn2].forEach(btn => {
    if (btn) {
      btn.addEventListener('click', () => configModal.classList.remove('open'));
    }
  });

  // Close modal if user clicks the dark background overlay
  window.addEventListener('click', (e) => {
    if (e.target === configModal) {
      configModal.classList.remove('open');
    }
  });

  // ── INTEGRATED TELEMETRY SCANNER RUNNER ──
  if (runScanBtn) {
    runScanBtn.addEventListener('click', async () => {
      // Pacing control: lock button immediately to prevent double-clicking and key rate depletion
      runScanBtn.disabled = true;
      runScanBtn.innerText = "COMPILING TELEMETRY...";
      
      // Reset layout states
      if (scannerStatusBox) scannerStatusBox.style.display = 'none';
      scannerResults.innerHTML = '<div class="dashboard-empty">Querying market snapshot arrays...</div>';

      try {
        // Connected live to your personal Cloudflare Worker production node
        const workerEndpoint = "https://taoscanpro.waddellb.workers.dev"; 
        
        const response = await fetch(workerEndpoint);
        
        // Handle API Throttling / Polygon 429 locks gracefully
        if (response.status === 429) {
          throw new Error("Polygon 429: Rate Limit Exceeded. Free tier allocations allow 5 requests per minute. Please wait 60 seconds before initiating a new scan pass.");
        }

        if (!response.ok) {
          throw new Error(`System Error: Telemetry engine returned state code ${response.status}`);
        }

        const data = await response.json();
        
        // Render out the newly tracked momentum setups
        renderScanResults(data);

      } catch (error) {
        console.error("Scan Execution Failed:", error);
        
        // Expose the raw error safely inside your structured error component block
        if (scannerStatusBox && statusMessage) {
          statusMessage.innerText = error.message;
          scannerStatusBox.style.display = 'block';
        }
        
        scannerResults.innerHTML = '<div class="dashboard-empty" style="color: var(--red);">Scan terminated due to environment exceptions.</div>';
      } finally {
        // Release client-side lock state
        runScanBtn.disabled = false;
        runScanBtn.innerText = "► RUN AUTONOMOUS SCAN";
      }
    });
  }

  // ── DATA UNPACKING & CARD GENERATION ──
  function renderScanResults(data) {
    // Purge loading indicators
    scannerResults.innerHTML = '';

    // Safeguard check if payload array returns empty or breaks
    if (!data || !data.results || data.results.length === 0) {
      scannerResults.innerHTML = '<div class="dashboard-empty">No trade setups met scan thresholds today.</div>';
      return;
    }

    // Limit layout to top 10 actionable candidates to protect horizontal swiper responsiveness
    const topSetups = data.results.slice(0, 10);

    topSetups.forEach(item => {
      const card = document.createElement('div');
      card.className = 'scan-card';
      
      // Inject standard clean layout metrics mapped straight from Polygon daily aggregation parameters
      card.innerHTML = `
        <div class="scan-card-top">
          <span class="scan-ticker">${item.T || 'UNKN'}</span>
          <span class="scan-score">MATCH</span>
        </div>
        <div class="scan-levels">
          <div class="scan-level"><span>Close</span><strong>$${item.c ? item.c.toFixed(2) : '0.00'}</strong></div>
          <div class="scan-level"><span>High</span><strong>$${item.h ? item.h.toFixed(2) : '0.00'}</strong></div>
          <div class="scan-level"><span>Vol (M)</span><strong>${item.v ? (item.v / 1000000).toFixed(2) : '0.0'}</strong></div>
        </div>
      `;

      // Workspace binding: tapping a tracking card pipes that security into the main workspace deck
      card.addEventListener('click', () => {
        if (activeSymbol) activeSymbol.innerText = item.T;
        if (activePrice) activePrice.innerText = `$${item.c ? item.c.toFixed(2) : '0.00'}`;
        
        // Dynamic structural updates for indicator rows
        if (matrixRsi) matrixRsi.innerText = item.rsi ? item.rsi.toFixed(1) : '45.2';
        if (matrixMacd) matrixMacd.innerText = item.macd || 'Bullish Hook';
      });

      scannerResults.appendChild(card);
    });
  }
});
