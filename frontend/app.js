import { BarcodeScanner } from './scanner.js';
import { CONFIG } from './config.js';

const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';

if (tg) {
  tg.ready();
  tg.expand();
  if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
  if (tg.setHeaderColor) tg.setHeaderColor('#07080b');
  if (tg.setBackgroundColor) tg.setBackgroundColor('#07080b');
}

function haptic(type = 'success') {
  try {
    if (!tg?.HapticFeedback) return;
    if (['light', 'medium', 'heavy', 'rigid', 'soft'].includes(type)) {
      tg.HapticFeedback.impactOccurred(type);
    } else {
      tg.HapticFeedback.notificationOccurred(type);
    }
  } catch (e) {}
}

const el = {
  btnStartScan: document.getElementById('btn-start-scan'),
  btnRescan: document.getElementById('btn-rescan'),
  btnRetry: document.getElementById('btn-retry'),
  btnTorch: document.getElementById('btn-torch'),
  torchOffIcon: document.getElementById('torch-off-icon'),
  torchOnIcon: document.getElementById('torch-on-icon'),
  placeholder: document.getElementById('scanner-placeholder'),
  overlay: document.getElementById('scanner-overlay'),
  snapshotCanvas: document.getElementById('snapshot-canvas'),
  nativeVideo: document.getElementById('native-video'),
  reader: document.getElementById('reader'),
  loadingState: document.getElementById('loading-state'),
  loadingStatusText: document.getElementById('loading-status-text'),
  errorCard: document.getElementById('error-card'),
  errorTitle: document.getElementById('error-title'),
  errorDesc: document.getElementById('error-desc'),
  notFoundCard: document.getElementById('not-found-card'),
  nfTitle: document.getElementById('nf-title'),
  nfDesc: document.getElementById('nf-desc'),
  resultCard: document.getElementById('result-card'),
  actionButtons: document.getElementById('action-buttons'),
  resImage: document.getElementById('res-image'),
  resImagePlaceholder: document.getElementById('res-image-placeholder'),
  resBrand: document.getElementById('res-brand'),
  resArticle: document.getElementById('res-article'),
  resTitle: document.getElementById('res-title'),
  resWbPrice: document.getElementById('res-wb-price'),
  resOurPrice: document.getElementById('res-our-price'),
  resWbLink: document.getElementById('res-wb-link'),
};

let torchActive = false;
let lastScannedCode = '';
let currentAbortController = null;

const scanner = new BarcodeScanner({
  videoEl: el.nativeVideo,
  readerEl: el.reader,
  snapshotCanvas: el.snapshotCanvas,
  onDetected: (code) => handleBarcodeScanned(code),
  onError: (err) => showError('Ошибка камеры', 'Проверьте разрешения в настройках.')
});

el.btnStartScan.addEventListener('click', startScanSession);
el.btnRescan.addEventListener('click', startScanSession);

async function startScanSession() {
  resetUi();
  haptic('light');
  el.placeholder.classList.add('hidden');
  el.overlay.classList.remove('hidden');

  await scanner.start();

  if (scanner.supportsTorch) {
    el.btnTorch.classList.remove('hidden');
    torchActive = false;
    updateTorchUi();
  } else {
    el.btnTorch.classList.add('hidden');
  }
}

el.btnTorch.addEventListener('click', async () => {
  haptic('light');
  torchActive = !torchActive;
  const ok = await scanner.toggleTorch(torchActive);
  if (!ok) {
    torchActive = false;
  }
  updateTorchUi();
});

function updateTorchUi() {
  if (torchActive) {
    el.torchOffIcon.classList.add('hidden');
    el.torchOnIcon.classList.remove('hidden');
    el.btnTorch.classList.add('bg-amber-500/20', 'border-amber-400/40');
    el.btnTorch.classList.remove('bg-black/60', 'border-white/10');
  } else {
    el.torchOnIcon.classList.add('hidden');
    el.torchOffIcon.classList.remove('hidden');
    el.btnTorch.classList.remove('bg-amber-500/20', 'border-amber-400/40');
    el.btnTorch.classList.add('bg-black/60', 'border-white/10');
  }
}

el.btnRetry.addEventListener('click', () => {
  haptic('light');
  if (lastScannedCode) handleBarcodeScanned(lastScannedCode);
  else startScanSession();
});

async function handleBarcodeScanned(barcode) {
  resetUi(true);
  lastScannedCode = barcode;
  haptic('success');

  el.overlay.classList.add('hidden');
  el.btnTorch.classList.add('hidden');
  el.loadingState.classList.remove('hidden');

  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();

  el.loadingStatusText.textContent = 'Штрихкод распознан…';

  try {
    const timeoutId = setTimeout(() => currentAbortController.abort(), 30000);

    const url = `${CONFIG.API_BASE_URL}?barcode=${encodeURIComponent(barcode)}&_=${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const res = await fetch(url, {
      method: 'GET',
      signal: currentAbortController.signal,
      cache: 'no-store',
      headers: {
        'X-Telegram-Init-Data': initData || ''
      }
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Ошибка сервера (${res.status}). Повторите попытку.`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        if (!chunk) continue;

        let eventType = 'message';
        let data = '';

        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          if (line.startsWith('data: ')) data = line.slice(6);
        }

        if (eventType === 'status') {
          try {
            const parsed = JSON.parse(data);
            el.loadingStatusText.textContent = parsed.message;
          } catch(e) {}
        } else if (eventType === 'result') {
          try {
            const parsed = JSON.parse(data);
            el.loadingState.classList.add('hidden');
            renderResult(parsed);
            return;
          } catch(e) {}
        } else if (eventType === 'error') {
          try {
            const parsed = JSON.parse(data);
            handleErrorResult(parsed);
            return;
          } catch(e) {}
        }
      }
    }

  } catch (err) {
    el.loadingState.classList.add('hidden');
    if (err.name === 'AbortError') showError('Превышено время ожидания', 'Сервер не ответил вовремя. Проверьте интернет.');
    else if (err.message.includes('fetch') || err.message.includes('Network')) showError('Ошибка соединения', 'Проверьте подключение к интернету.');
    else showError('Ошибка поиска', err.message);
  }
}

function handleErrorResult(data) {
  el.loadingState.classList.add('hidden');
  if (data.error === 'Not found in databases') {
    showNotFound('Товар не найден', `Штрихкод ${data.barcode} отсутствует в базах данных.`);
  } else if (data.error === 'not_found_on_wb') {
    showNotFound('Товар не найден на Wildberries', `Нашёлся «${data.sourceProduct.name}», но релевантных предложений на Wildberries нет.`);
  } else if (data.error === 'duplicate_request') {
    showError('Поиск уже выполняется', 'Дождитесь завершения текущего запроса.');
  } else {
    showError('Ошибка поиска', data.message || 'Ошибка сервера. Повторите попытку.');
  }
}

function renderResult(data) {
  const wb = data.wildberries;
  const src = data.sourceProduct;

  el.resTitle.textContent = wb.name || src.name;
  el.resBrand.textContent = wb.brand || src.brand || 'Бренд';
  el.resArticle.textContent = wb.article ? `Артикул WB: ${wb.article}` : '';

  const photoUrl = wb.image || wb.fallbackImage || src.image;
  if (photoUrl) {
    el.resImage.src = photoUrl;
    el.resImage.onerror = () => {
      el.resImage.classList.add('hidden');
      el.resImagePlaceholder.classList.remove('hidden');
    };
    el.resImage.classList.remove('hidden');
    el.resImagePlaceholder.classList.add('hidden');
  } else {
    el.resImage.classList.add('hidden');
    el.resImagePlaceholder.classList.remove('hidden');
  }

  el.resWbPrice.textContent = `${Math.round(wb.price).toLocaleString('ru-RU')} ₽`;
  el.resOurPrice.textContent = `${Number(data.ourPrice).toLocaleString('ru-RU')} ₽`;

  el.resWbLink.href = wb.url;
  el.resWbLink.onclick = (e) => {
    e.preventDefault();
    haptic('light');
    if (tg && typeof tg.openLink === 'function') tg.openLink(wb.url);
    else window.open(wb.url, '_blank', 'noopener,noreferrer');
  };

  el.resultCard.classList.remove('hidden');
  el.actionButtons.classList.remove('hidden');
  haptic('success');
}

function showNotFound(title, desc) {
  el.nfTitle.textContent = title;
  el.nfDesc.textContent = desc;
  el.notFoundCard.classList.remove('hidden');
  el.actionButtons.classList.remove('hidden');
  haptic('warning');
}

function showError(title, desc) {
  el.errorTitle.textContent = title;
  el.errorDesc.textContent = desc;
  el.errorCard.classList.remove('hidden');
  el.actionButtons.classList.remove('hidden');
  haptic('error');
}

function resetUi(keepSnapshot = false) {
  if (currentAbortController) currentAbortController.abort();
  el.resultCard.classList.add('hidden');
  el.errorCard.classList.add('hidden');
  el.notFoundCard.classList.add('hidden');
  el.loadingState.classList.add('hidden');
  el.actionButtons.classList.add('hidden');

  if (!keepSnapshot) {
    el.snapshotCanvas.classList.add('hidden');
    el.snapshotCanvas.style.transform = 'none';
  }

  el.btnTorch.classList.add('hidden');
  if (scanner.zoomBadge) scanner.zoomBadge.classList.add('hidden');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    scanner.stop();
    torchActive = false;
    updateTorchUi();

    if (el.resultCard.classList.contains('hidden') &&
        el.errorCard.classList.contains('hidden') &&
        el.notFoundCard.classList.contains('hidden') &&
        el.loadingState.classList.contains('hidden')) {

      el.overlay.classList.add('hidden');
      el.snapshotCanvas.classList.add('hidden');
      el.btnTorch.classList.add('hidden');
      el.placeholder.classList.remove('hidden');
    }
  }
});

window.addEventListener('pagehide', () => scanner.stop());