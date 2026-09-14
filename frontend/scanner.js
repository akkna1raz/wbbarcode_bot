export class BarcodeScanner {
  constructor(options) {
    this.videoEl = options.videoEl;
    this.readerEl = options.readerEl;
    this.snapshotCanvas = options.snapshotCanvas;
    this.onDetected = options.onDetected;
    this.onError = options.onError;
    
    this.zoomBadge = document.getElementById('zoom-badge');

    this.isScanning = false;
    this.stream = null;
    this.videoTrack = null;
    this.html5QrCode = null;
    this.detector = null;
    this.rafId = null;
    
    this.supportsTorch = false;
    this.candidateCode = '';
    this.candidateHits = 0;
    this.lastDetectedTime = 0;
    
    this.currentZoom = 1.0;
    this.minZoom = 1.0;
    this.maxZoom = 4.0;
    this.hasHardwareZoom = false;
    
    this.initTouchListeners();
  }

  async checkNativeDetector() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('ean_13') || formats.includes('ean_8')) {
          this.detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async start() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.candidateCode = '';
    this.candidateHits = 0;
    this.currentZoom = 1.0;

    this.snapshotCanvas.classList.add('hidden');
    this.videoEl.style.transform = 'none';

    await this.stopStreams();

    const hasNative = await this.checkNativeDetector();
    if (hasNative) {
      await this.startNative();
    } else {
      await this.startFallback();
    }
  }

  async startNative() {
    try {
      this.readerEl.classList.add('hidden');
      this.videoEl.classList.remove('hidden');

      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false
      }).catch(() => navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }, audio: false
      }));

      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      this.videoTrack = this.stream.getVideoTracks()[0];
      
      this.evalCapabilities();
      this.scanNativeFrame();
    } catch (err) {
      await this.startFallback();
    }
  }

  scanNativeFrame() {
    if (!this.isScanning || !this.detector || this.videoEl.readyState < 2) return;
    
    this.detector.detect(this.videoEl).then(barcodes => {
      if (barcodes.length > 0) {
        const raw = barcodes[0].rawValue?.trim();
        if (raw) this.processCandidate(raw);
      }
    }).catch(() => {}).finally(() => {
      if (this.isScanning) {
        setTimeout(() => {
          this.rafId = requestAnimationFrame(() => this.scanNativeFrame());
        }, 65);
      }
    });
  }

  async startFallback() {
    this.videoEl.classList.add('hidden');
    this.readerEl.classList.remove('hidden');
    this.supportsTorch = false;

    if (!this.html5QrCode) {
      this.html5QrCode = new window.Html5Qrcode('reader', { verbose: false });
    }

    try {
      await this.html5QrCode.start(
        { facingMode: 'environment' },
        { fps: 15, qrbox: (w, h) => ({ width: Math.floor(w * 0.8), height: Math.floor(h * 0.45) }) },
        (decodedText) => this.processCandidate(decodedText.trim()),
        () => {}
      );
      
      const fbVideo = document.querySelector('#reader video');
      if (fbVideo && fbVideo.srcObject) {
        this.videoTrack = fbVideo.srcObject.getVideoTracks()[0];
        this.evalCapabilities();
      }
    } catch (err) {
      if (typeof this.onError === 'function') this.onError(err);
      this.isScanning = false;
    }
  }

  evalCapabilities() {
    if (!this.videoTrack) {
      this.supportsTorch = false;
      return;
    }
    try {
      const caps = this.videoTrack.getCapabilities ? this.videoTrack.getCapabilities() : {};
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      
      if (caps.torch !== undefined) {
        this.supportsTorch = true;
      } else if (isIOS) {
        this.supportsTorch = true; 
      } else {
        const supported = navigator.mediaDevices.getSupportedConstraints();
        this.supportsTorch = !!supported.torch;
      }

      if (caps.zoom && caps.zoom.min && caps.zoom.max) {
        this.hasHardwareZoom = true;
        this.minZoom = caps.zoom.min;
        this.maxZoom = Math.min(caps.zoom.max, 5.0);
      } else {
        this.hasHardwareZoom = false;
      }
    } catch (e) {
      this.supportsTorch = true;
      this.hasHardwareZoom = false;
    }
  }

  async toggleTorch(enable) {
    if (!this.videoTrack) return false;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ torch: !!enable }] });
      return true;
    } catch (e) {
      try {
        await this.videoTrack.applyConstraints({ torch: !!enable });
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  processCandidate(code) {
    if (!code || code.length < 8 || !this.isScanning) return;
    const now = Date.now();

    if (code === this.candidateCode) {
      this.candidateHits++;
      if (this.candidateHits >= 2 && (now - this.lastDetectedTime > 2000)) {
        this.lastDetectedTime = now;
        this.freezeSnapshot();
        this.stop();
        if (typeof this.onDetected === 'function') this.onDetected(code);
      }
    } else {
      this.candidateCode = code;
      this.candidateHits = 1;
    }
  }

  freezeSnapshot() {
    try {
      const vid = !this.videoEl.classList.contains('hidden') ? this.videoEl : document.querySelector('#reader video');
      if (vid && vid.videoWidth > 0 && vid.videoHeight > 0 && this.snapshotCanvas) {
        this.snapshotCanvas.width = vid.videoWidth;
        this.snapshotCanvas.height = vid.videoHeight;
        const ctx = this.snapshotCanvas.getContext('2d');
        ctx.drawImage(vid, 0, 0, vid.videoWidth, vid.videoHeight);
        
        if (!this.hasHardwareZoom && this.currentZoom > 1.0) {
          this.snapshotCanvas.style.transform = `scale(${this.currentZoom})`;
        } else {
          this.snapshotCanvas.style.transform = 'none';
        }

        this.snapshotCanvas.classList.remove('hidden');
        if (this.videoEl) this.videoEl.classList.add('hidden');
        if (this.readerEl) this.readerEl.classList.add('hidden');
      }
    } catch (e) {}
  }

  stop() {
    this.isScanning = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    
    if (this.videoTrack && this.supportsTorch) {
       this.toggleTorch(false).catch(()=>{}).finally(()=>{
         this.stopStreams();
       });
    } else {
       this.stopStreams();
    }
  }
  
  async stopStreams() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.videoTrack = null;
    }
    
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }

    if (this.html5QrCode && this.html5QrCode.isScanning) {
      try {
        await this.html5QrCode.stop();
        this.html5QrCode.clear();
      } catch (e) {}
    }
  }

  initTouchListeners() {
    const wrapper = document.getElementById('scanner-wrapper');
    let startDist = 0;
    let initialZoom = 1.0;
    let badgeTimeout = null;

    wrapper.addEventListener('touchstart', (e) => {
      if (!this.isScanning || e.touches.length < 2) return;
      startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      initialZoom = this.currentZoom;
    }, { passive: true });

    wrapper.addEventListener('touchmove', (e) => {
      if (!this.isScanning || e.touches.length < 2 || startDist === 0) return;
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const scale = dist / startDist;
      
      let newZoom = Math.max(this.minZoom, Math.min(initialZoom * scale, this.maxZoom));
      this.currentZoom = newZoom;

      if (this.zoomBadge) {
        this.zoomBadge.textContent = `${newZoom.toFixed(1)}×`;
        this.zoomBadge.classList.remove('hidden');
        clearTimeout(badgeTimeout);
        badgeTimeout = setTimeout(() => this.zoomBadge.classList.add('hidden'), 1500);
      }

      if (this.hasHardwareZoom && this.videoTrack) {
        this.videoTrack.applyConstraints({ advanced: [{ zoom: newZoom }] }).catch(()=>{});
      } else {
        const transform = `scale(${newZoom})`;
        this.videoEl.style.transform = transform;
        const fbVideo = document.querySelector('#reader video');
        if (fbVideo) fbVideo.style.transform = transform;
      }
    }, { passive: true });
    
    wrapper.addEventListener('touchend', () => { startDist = 0; }, { passive: true });
  }
}