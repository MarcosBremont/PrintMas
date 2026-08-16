(() => {
  'use strict';

  const state = {
    file: null,
    totalPages: 0,
    pageMode: 'all',
    pageRange: '',
    pagesToPrint: 0, // páginas efectivas que se cobran/imprimen
    copies: 1,
    colorMode: 'bw',
    orientation: 'portrait',
    pricing: { bwPage: 1.5, colorPage: 5, currency: 'MXN' }
  };

  // ---------------------------------------------------------------------
  // Navegación entre pasos
  // ---------------------------------------------------------------------
  function goToStep(step) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById(`screen-${step}`).classList.add('active');

    document.querySelectorAll('.step').forEach((el) => {
      const n = Number(el.dataset.step);
      el.classList.toggle('active', n === step);
      el.classList.toggle('done', n < step);
    });
  }

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.back)));
  });

  // ---------------------------------------------------------------------
  // Config de precios desde el backend (fuente única de verdad)
  // ---------------------------------------------------------------------
  async function loadPricing() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.pricing) state.pricing = data.pricing;
    } catch (e) {
      console.warn('No se pudo cargar /api/config, usando precios por defecto.', e);
    }
  }
  loadPricing();

  // ---------------------------------------------------------------------
  // PASO 1: Subida de archivo + lectura de páginas con pdf-lib
  // ---------------------------------------------------------------------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const filePreview = document.getElementById('filePreview');
  const fileNameEl = document.getElementById('fileName');
  const fileMetaEl = document.getElementById('fileMeta');
  const removeFileBtn = document.getElementById('removeFileBtn');
  const uploadError = document.getElementById('uploadError');
  const toStep2Btn = document.getElementById('toStep2Btn');

  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  ['dragover', 'dragenter'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  removeFileBtn.addEventListener('click', () => {
    state.file = null;
    state.totalPages = 0;
    fileInput.value = '';
    filePreview.hidden = true;
    dropzone.hidden = false;
    toStep2Btn.disabled = true;
  });

  async function handleFile(file) {
    hideError(uploadError);
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      showError(uploadError, 'Solo se permiten archivos PDF.');
      return;
    }

    const MAX_SIZE = 100 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      showError(uploadError, 'El archivo supera el límite de 100 MB.');
      return;
    }

    showLoading('Leyendo tu PDF…');
    try {
      const buffer = await file.arrayBuffer();
      const pdfDoc = await PDFLib.PDFDocument.load(buffer, { ignoreEncryption: true });
      const pageCount = pdfDoc.getPageCount();

      if (pageCount < 1) {
        throw new Error('El PDF no contiene páginas válidas.');
      }

      state.file = file;
      state.totalPages = pageCount;

      fileNameEl.textContent = file.name;
      fileMetaEl.textContent = `${pageCount} página${pageCount !== 1 ? 's' : ''} · ${formatBytes(file.size)}`;

      dropzone.hidden = true;
      filePreview.hidden = false;
      toStep2Btn.disabled = false;
    } catch (err) {
      console.error(err);
      showError(uploadError, 'No se pudo leer el PDF. Verifica que el archivo no esté dañado o protegido.');
      state.file = null;
      state.totalPages = 0;
      toStep2Btn.disabled = true;
    } finally {
      hideLoading();
    }
  }

  toStep2Btn.addEventListener('click', () => {
    document.getElementById('pageCountLabel').innerHTML =
      `Tu documento tiene <strong>${state.totalPages}</strong> página${state.totalPages !== 1 ? 's' : ''}`;
    goToStep(2);
  });

  // ---------------------------------------------------------------------
  // PASO 2: Configuración de impresión
  // ---------------------------------------------------------------------
  const pageRangeInput = document.getElementById('pageRangeInput');
  const rangeHint = document.getElementById('rangeHint');
  const copiesInput = document.getElementById('copiesInput');
  const toStep3Btn = document.getElementById('toStep3Btn');

  document.querySelectorAll('input[name="pageMode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.pageMode = e.target.value;
      pageRangeInput.disabled = state.pageMode !== 'range';
      if (state.pageMode === 'all') {
        pageRangeInput.value = '';
        rangeHint.textContent = '';
      }
    });
  });

  pageRangeInput.addEventListener('input', () => {
    state.pageRange = pageRangeInput.value.trim();
  });

  document.getElementById('copiesMinus').addEventListener('click', () => {
    copiesInput.value = Math.max(1, Number(copiesInput.value) - 1);
  });
  document.getElementById('copiesPlus').addEventListener('click', () => {
    copiesInput.value = Math.min(99, Number(copiesInput.value) + 1);
  });

  document.querySelectorAll('input[name="colorMode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => (state.colorMode = e.target.value));
  });
  document.querySelectorAll('input[name="orientation"]').forEach((radio) => {
    radio.addEventListener('change', (e) => (state.orientation = e.target.value));
  });

  // Parsea "1-3,5,8-9" -> número de páginas efectivas, validando contra el total
  function parsePageRange(rangeStr, totalPages) {
    const parts = rangeStr.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;

    const pages = new Set();
    for (const part of parts) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : start;
      if (start < 1 || end < start || end > totalPages) return null;
      for (let p = start; p <= end; p++) pages.add(p);
    }
    return pages.size;
  }

  toStep3Btn.addEventListener('click', () => {
    state.copies = Math.min(Math.max(Number(copiesInput.value) || 1, 1), 99);

    if (state.pageMode === 'range') {
      const count = parsePageRange(state.pageRange, state.totalPages);
      if (count === null) {
        rangeHint.textContent = `Ingresa un rango válido entre 1 y ${state.totalPages} (ej. 1-3,5).`;
        return;
      }
      state.pagesToPrint = count;
    } else {
      state.pagesToPrint = state.totalPages;
    }

    rangeHint.textContent = '';
    renderQuote();
    goToStep(3);
  });

  // ---------------------------------------------------------------------
  // PASO 3: Cotizador
  // ---------------------------------------------------------------------
  function pricePerPage() {
    return state.colorMode === 'color' ? state.pricing.colorPage : state.pricing.bwPage;
  }

  function calculateTotal() {
    return state.pagesToPrint * state.copies * pricePerPage();
  }

  function money(amount) {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: state.pricing.currency || 'MXN'
    }).format(amount);
  }

  function renderQuote() {
    document.getElementById('quoteFileName').textContent = state.file?.name || '—';
    document.getElementById('quotePages').textContent =
      state.pageMode === 'all'
        ? `Todas (${state.pagesToPrint})`
        : `${state.pagesToPrint} de ${state.totalPages} (${state.pageRange})`;
    document.getElementById('quoteCopies').textContent = state.copies;
    document.getElementById('quoteColorMode').textContent =
      state.colorMode === 'color' ? '🎨 Color' : '⚫ Blanco y Negro';
    document.getElementById('quoteOrientation').textContent =
      state.orientation === 'landscape' ? '📃 Horizontal' : '📄 Vertical';
    document.getElementById('quotePricePerPage').textContent = money(pricePerPage());
    document.getElementById('quoteTotal').textContent = money(calculateTotal());
  }

  document.getElementById('toStep4Btn').addEventListener('click', () => {
    renderFinalSummary();
    goToStep(4);
  });

  // ---------------------------------------------------------------------
  // PASO 4: Pago / confirmación
  // ---------------------------------------------------------------------
  function renderFinalSummary() {
    const total = calculateTotal();
    document.getElementById('finalSummary').innerHTML = `
      <div class="quote-row"><span>Documento</span><span>${escapeHtml(state.file?.name || '')}</span></div>
      <div class="quote-row"><span>Páginas</span><span>${state.pagesToPrint} × ${state.copies} copia(s)</span></div>
      <div class="quote-row"><span>Modo</span><span>${state.colorMode === 'color' ? 'Color' : 'Blanco y Negro'}</span></div>
      <hr />
      <div class="quote-row quote-total"><span>Total a pagar</span><span>${money(total)}</span></div>
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  const payBtn = document.getElementById('payBtn');
  const paymentError = document.getElementById('paymentError');

  payBtn.addEventListener('click', async () => {
    if (!state.file) {
      showError(paymentError, 'No hay ningún archivo cargado.');
      return;
    }

    hideError(paymentError);
    payBtn.disabled = true;
    showLoading('Procesando pago…');

    try {
      // Simulación de pasarela de pago
      await simulatePayment();

      showLoading('Enviando documento a la impresora…');
      const result = await submitPrintOrder();

      hideLoading();
      document.getElementById('orderIdLabel').textContent = result.orderId || '—';
      resetToStart(false);
      goToStep('success');
    } catch (err) {
      hideLoading();
      showError(paymentError, err.message || 'Ocurrió un error al procesar tu orden.');
    } finally {
      payBtn.disabled = false;
    }
  });

  function simulatePayment() {
    return new Promise((resolve) => setTimeout(resolve, 1200));
  }

  async function submitPrintOrder() {
    const formData = new FormData();
    formData.append('file', state.file);
    formData.append('pageMode', state.pageMode);
    formData.append('pageRange', state.pageRange);
    formData.append('copies', String(state.copies));
    formData.append('colorMode', state.colorMode);
    formData.append('orientation', state.orientation);
    formData.append('totalPages', String(state.totalPages));

    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || 'No se pudo enviar el documento a impresión.');
    }
    return data;
  }

  document.getElementById('newOrderBtn').addEventListener('click', () => {
    resetToStart(true);
  });

  function resetToStart(navigate) {
    state.file = null;
    state.totalPages = 0;
    state.pageMode = 'all';
    state.pageRange = '';
    state.pagesToPrint = 0;
    state.copies = 1;
    state.colorMode = 'bw';
    state.orientation = 'portrait';

    fileInput.value = '';
    filePreview.hidden = true;
    dropzone.hidden = false;
    toStep2Btn.disabled = true;
    pageRangeInput.value = '';
    pageRangeInput.disabled = true;
    copiesInput.value = 1;
    document.querySelector('input[name="pageMode"][value="all"]').checked = true;
    document.querySelector('input[name="colorMode"][value="bw"]').checked = true;
    document.querySelector('input[name="orientation"][value="portrait"]').checked = true;

    if (navigate) goToStep(1);
  }

  // ---------------------------------------------------------------------
  // Utilidades UI
  // ---------------------------------------------------------------------
  function showError(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }
  function hideError(el) {
    el.hidden = true;
    el.textContent = '';
  }

  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  function showLoading(text) {
    loadingText.textContent = text || 'Procesando…';
    loadingOverlay.hidden = false;
  }
  function hideLoading() {
    loadingOverlay.hidden = true;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ---------------------------------------------------------------------
  // Registro del Service Worker (PWA)
  // ---------------------------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW no registrado:', e));
    });
  }
})();
