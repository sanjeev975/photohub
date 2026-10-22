    // Canonical Physical Constants
    const MM_PER_INCH = 25.4;
    const PRINT_DPI = 300;
    const MAX_PEOPLE = 12;

    // Paper sizes in millimeters [width, height]
    const PAPER_SIZES = {
      'A4': { width: 210, height: 297, label: 'A4' },
      '4x6': { width: 101.6, height: 152.4, label: '4 × 6 inch' }
    };

    // Standard preset dimensions in millimeters
    const PRESET_DIMS = {
      'a4_6per_row': { width: 32, height: 41.14, label: 'A4 6 Photos/Row (Equal Margins) - 3.2x4.114cm' },
      '35x45': { width: 35, height: 45, label: 'Indian Passport / Visa (35 × 45 mm)' },
      '50.8x50.8': { width: 50.8, height: 50.8, label: 'US 2 × 2 in (50.8 × 50.8 mm)' },
      '50x50': { width: 50, height: 50, label: 'Square Visa (50 × 50 mm)' },
      '35x35': { width: 35, height: 35, label: 'Square Small (35 × 35 mm)' },
      'custom': { width: 32, height: 41.14, label: 'Custom' }
    };

    // ========================================================
    // SECURITY LAYER
    // - All limits are enforced here in code (never trust DOM attributes or stored data)
    // - This app is fully static: no API keys, no server calls, photos never leave the browser.
    // ========================================================
    const MAX_COPIES = 200;                    // per photo
    const MAX_TOTAL_ITEMS = 400;               // hard cap on photos placed on all sheets
    const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // per uploaded file
    const MAX_IMAGE_PIXELS = 80 * 1000 * 1000; // decoded pixel cap (decompression-bomb guard)
    const HEIC2ANY_URL = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';

    function clampNum(value, min, max, fallback) {
      const n = typeof value === 'string' ? parseFloat(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    function isHexColor(v) {
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
    }

    // Only allow image sources this app creates itself (blob: or data:image) to be written into markup
    function safeImgSrc(src) {
      if (typeof src !== 'string') return '';
      if (/^blob:[^\s"'<>]+$/.test(src)) return src;
      if (src.startsWith('data:image/jpeg;base64,') || src.startsWith('data:image/png;base64,')) return src;
      return '';
    }

    // Validate and normalise anything read back from localStorage (it is attacker-editable)
    function sanitizeDefaults(raw) {
      const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      const F = FACTORY_DEFAULTS;
      const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
      const get = (k) => (has(k) ? src[k] : undefined);
      const bool = (k) => (typeof get(k) === 'boolean' ? get(k) : F[k]);
      const presetKey = get('presetKey');
      const paperSize = get('paperSize');
      const orientation = get('orientation');
      const layoutMode = get('layoutMode');
      return {
        singleCopies: Math.round(clampNum(get('singleCopies'), 1, MAX_COPIES, F.singleCopies)),
        presetKey: (typeof presetKey === 'string' && Object.prototype.hasOwnProperty.call(PRESET_DIMS, presetKey)) ? presetKey : F.presetKey,
        customWidthMm: clampNum(get('customWidthMm'), 15, 150, F.customWidthMm),
        customHeightMm: clampNum(get('customHeightMm'), 15, 150, F.customHeightMm),
        paperSize: (typeof paperSize === 'string' && Object.prototype.hasOwnProperty.call(PAPER_SIZES, paperSize)) ? paperSize : F.paperSize,
        orientation: (orientation === 'portrait' || orientation === 'landscape') ? orientation : F.orientation,
        layoutMode: (layoutMode === 'single' || layoutMode === 'mixed') ? layoutMode : F.layoutMode,
        sheetMarginMm: clampNum(get('sheetMarginMm'), 0.5, 60, F.sheetMarginMm),
        sheetMarginTopMm: clampNum(get('sheetMarginTopMm'), 0, 100, F.sheetMarginTopMm),
        photoSpacingMm: clampNum(get('photoSpacingMm'), 0, 25, F.photoSpacingMm),
        borderThicknessMm: clampNum(get('borderThicknessMm'), 0, 2, F.borderThicknessMm),
        borderColor: isHexColor(get('borderColor')) ? get('borderColor') : F.borderColor,
        whiteBackground: bool('whiteBackground'),
        brightness: Math.round(clampNum(get('brightness'), 50, 150, F.brightness)),
        contrast: Math.round(clampNum(get('contrast'), 50, 150, F.contrast)),
        showCutGuides: bool('showCutGuides'),
        centerGrid: bool('centerGrid'),
        autoPreserve: bool('autoPreserve')
      };
    }

    // Identify real image type from file CONTENT (magic bytes), not from the file name or MIME type
    async function sniffImageKind(file) {
      const buf = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      const ascii = (a, b) => String.fromCharCode.apply(null, Array.from(buf.slice(a, b)));
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
      if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
      if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
      if (ascii(4, 8) === 'ftyp') {
        const brand = ascii(8, 12);
        if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'heic';
      }
      return null;
    }

    // HEIC/HEIF: Chrome/Edge/Firefox cannot decode it natively, so a converter is loaded on demand
    let heic2anyPromise = null;
    function loadHeic2Any() {
      if (window.heic2any) return Promise.resolve(window.heic2any);
      if (!heic2anyPromise) {
        heic2anyPromise = new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = HEIC2ANY_URL;
          s.crossOrigin = 'anonymous';
          s.referrerPolicy = 'no-referrer';
          s.onload = () => resolve(window.heic2any);
          s.onerror = () => { heic2anyPromise = null; reject(new Error('Could not load HEIC converter')); };
          document.head.appendChild(s);
        });
      }
      return heic2anyPromise;
    }

    // Canonical LocalStorage Key for User-Preserved Defaults
    const STORAGE_KEY_DEFAULTS = 'passport_hub_user_default_settings_v1';

    // Factory Defaults (4 copies, Indian 35x45 standard, 0.3mm border, A4 portrait)
    const FACTORY_DEFAULTS = {
      singleCopies: 4,
      presetKey: '35x45',
      customWidthMm: 35,
      customHeightMm: 45,
      paperSize: 'A4',
      orientation: 'portrait',
      layoutMode: 'single',
      sheetMarginMm: 10,
      sheetMarginTopMm: 10,
      photoSpacingMm: 3,
      borderThicknessMm: 0.3,
      borderColor: '#000000',
      whiteBackground: true,
      brightness: 100,
      contrast: 100,
      showCutGuides: true,
      centerGrid: true,
      autoPreserve: true
    };

    function getUserDefaultSettings() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY_DEFAULTS);
        if (stored) {
          const parsed = JSON.parse(stored);
          return sanitizeDefaults(parsed);
        }
      } catch (e) {
        console.warn('Could not read user default settings:', e);
      }
      return { ...FACTORY_DEFAULTS };
    }

    function saveUserDefaultSettings(patch, notify = false) {
      try {
        const current = getUserDefaultSettings();
        const updated = sanitizeDefaults({ ...current, ...patch });
        localStorage.setItem(STORAGE_KEY_DEFAULTS, JSON.stringify(updated));
        updateDefaultsDisplayUI();
        if (notify) {
          const presetName = getPresetShortName(updated.presetKey, updated.customWidthMm, updated.customHeightMm);
          showToast(`Default settings saved: ${updated.singleCopies} copies · ${presetName} · ${updated.borderThicknessMm}mm border`, 'success');
        }
      } catch (e) {
        console.error('Failed to save user default settings:', e);
      }
    }

    function autoPreserveSetting(patch) {
      const current = getUserDefaultSettings();
      if (current.autoPreserve) {
        saveUserDefaultSettings(patch, false);
      }
    }

    function getPresetShortName(presetKey, customW, customH) {
      if (presetKey === '35x45') return 'Indian (35×45mm)';
      if (presetKey === 'a4_6per_row') return 'A4 6/row (32×41.14mm)';
      if (presetKey === '50.8x50.8') return 'US (50.8×50.8mm)';
      if (presetKey === '50x50') return 'Square (50×50mm)';
      if (presetKey === '35x35') return 'Square (35×35mm)';
      if (presetKey === 'custom') return `Custom (${customW || 35}×${customH || 45}mm)`;
      return PRESET_DIMS[presetKey]?.label || '35×45mm';
    }

    function updateDefaultsDisplayUI() {
      const d = getUserDefaultSettings();
      const presetShort = getPresetShortName(d.presetKey, d.customWidthMm, d.customHeightMm);
      const summaryText = `${d.singleCopies} Copies · ${presetShort}`;

      const pill = document.getElementById('sidebar-defaults-pill');
      if (pill) pill.textContent = summaryText;



      const modalCopies = document.getElementById('modal-default-copies');
      if (modalCopies) modalCopies.textContent = d.singleCopies.toString();

      const modalPreset = document.getElementById('modal-default-preset');
      if (modalPreset) modalPreset.textContent = presetShort;

      const modalPaper = document.getElementById('modal-default-paper');
      if (modalPaper) modalPaper.textContent = `${d.paperSize} (${d.orientation})`;

      const modalBorder = document.getElementById('modal-default-border');
      if (modalBorder) modalBorder.textContent = `${d.borderThicknessMm} mm (${d.borderColor})`;

      const modalMargin = document.getElementById('modal-default-margin');
      if (modalMargin) modalMargin.textContent = `${d.sheetMarginMm} mm`;

      const modalSpacing = document.getElementById('modal-default-spacing');
      if (modalSpacing) modalSpacing.textContent = `${d.photoSpacingMm} mm`;

      const toggleAuto = document.getElementById('toggle-auto-preserve');
      if (toggleAuto) toggleAuto.checked = !!d.autoPreserve;
    }

    function syncDefaultsFormInputs() {
      const d = getUserDefaultSettings();
      const selectPaper = document.getElementById('select-paper-size');
      if (selectPaper) selectPaper.value = d.paperSize;

      const selectOrientation = document.getElementById('select-paper-orientation');
      if (selectOrientation) selectOrientation.value = d.orientation;

      const inputCopies = document.getElementById('input-custom-copies');
      if (inputCopies) inputCopies.value = d.singleCopies;

      const quickDisplay = document.getElementById('quick-copies-display');
      if (quickDisplay) quickDisplay.textContent = d.singleCopies.toString();

      const inputMargin = document.getElementById('input-sheet-margin');
      if (inputMargin) inputMargin.value = d.sheetMarginMm.toString();

      const inputMarginTop = document.getElementById('input-sheet-margin-top');
      if (inputMarginTop) inputMarginTop.value = (d.sheetMarginTopMm !== undefined ? d.sheetMarginTopMm : d.sheetMarginMm).toString();

      const inputSpacing = document.getElementById('input-photo-spacing');
      if (inputSpacing) inputSpacing.value = d.photoSpacingMm.toString();

      const toggleCut = document.getElementById('toggle-cut-guides');
      if (toggleCut) toggleCut.checked = !!d.showCutGuides;

      const toggleCenter = document.getElementById('toggle-center-grid');
      if (toggleCenter) toggleCenter.checked = !!d.centerGrid;

      highlightCopyPresetButton(d.singleCopies);
    }

    function saveCurrentStateAsDefault(notify = true) {
      const person = getActivePerson();
      const patch = {
        singleCopies: AppState.singleCopies || 4,
        paperSize: AppState.paperSize || 'A4',
        orientation: AppState.orientation || 'portrait',
        layoutMode: AppState.layoutMode || 'single',
        sheetMarginMm: AppState.sheetMarginMm || 10,
        sheetMarginTopMm: AppState.sheetMarginTopMm !== undefined ? AppState.sheetMarginTopMm : (AppState.sheetMarginMm || 10),
        photoSpacingMm: AppState.photoSpacingMm || 3,
        showCutGuides: AppState.showCutGuides !== undefined ? AppState.showCutGuides : true,
        centerGrid: AppState.centerGrid !== undefined ? AppState.centerGrid : true,
        autoPreserve: document.getElementById('toggle-auto-preserve')?.checked !== false
      };

      if (person) {
        patch.presetKey = person.presetKey || '35x45';
        patch.customWidthMm = person.customWidthMm || 35;
        patch.customHeightMm = person.customHeightMm || 45;
        patch.borderThicknessMm = person.borderThicknessMm !== undefined ? person.borderThicknessMm : 0.3;
        patch.borderColor = person.borderColor || '#000000';
        patch.whiteBackground = person.whiteBackground !== undefined ? person.whiteBackground : true;
        patch.brightness = person.brightness ?? 100;
        patch.contrast = person.contrast ?? 100;
      }

      saveUserDefaultSettings(patch, notify);
    }

    function applySavedDefaultsToActivePhoto() {
      const d = getUserDefaultSettings();
      AppState.singleCopies = d.singleCopies;
      AppState.paperSize = d.paperSize;
      AppState.orientation = d.orientation;
      AppState.sheetMarginMm = d.sheetMarginMm;
      AppState.sheetMarginTopMm = d.sheetMarginTopMm !== undefined ? d.sheetMarginTopMm : d.sheetMarginMm;
      AppState.photoSpacingMm = d.photoSpacingMm;
      AppState.showCutGuides = d.showCutGuides;
      AppState.centerGrid = d.centerGrid;

      const person = getActivePerson();
      if (person) {
        person.presetKey = d.presetKey;
        person.customWidthMm = d.customWidthMm;
        person.customHeightMm = d.customHeightMm;
        person.borderThicknessMm = d.borderThicknessMm;
        person.borderColor = d.borderColor;
        person.whiteBackground = d.whiteBackground;
        person.brightness = d.brightness;
        person.contrast = d.contrast;
        person.copies = d.singleCopies;
        person.canvasCache = null;
        setActivePerson(person.id);
      }

      syncDefaultsFormInputs();
      syncCopiesUI();
      scheduleSheetRender();
      showToast('Applied your saved default settings to active photo', 'success');
    }

    function resetUserDefaultSettings() {
      try {
        localStorage.removeItem(STORAGE_KEY_DEFAULTS);
        saveUserDefaultSettings(FACTORY_DEFAULTS, false);
        AppState.singleCopies = FACTORY_DEFAULTS.singleCopies;
        AppState.paperSize = FACTORY_DEFAULTS.paperSize;
        AppState.orientation = FACTORY_DEFAULTS.orientation;
        AppState.sheetMarginMm = FACTORY_DEFAULTS.sheetMarginMm;
        AppState.sheetMarginTopMm = FACTORY_DEFAULTS.sheetMarginTopMm;
        AppState.photoSpacingMm = FACTORY_DEFAULTS.photoSpacingMm;
        AppState.showCutGuides = FACTORY_DEFAULTS.showCutGuides;
        AppState.centerGrid = FACTORY_DEFAULTS.centerGrid;

        const person = getActivePerson();
        if (person) {
          person.presetKey = FACTORY_DEFAULTS.presetKey;
          person.customWidthMm = FACTORY_DEFAULTS.customWidthMm;
          person.customHeightMm = FACTORY_DEFAULTS.customHeightMm;
          person.borderThicknessMm = FACTORY_DEFAULTS.borderThicknessMm;
          person.borderColor = FACTORY_DEFAULTS.borderColor;
          person.whiteBackground = FACTORY_DEFAULTS.whiteBackground;
          person.brightness = FACTORY_DEFAULTS.brightness;
          person.contrast = FACTORY_DEFAULTS.contrast;
          person.copies = FACTORY_DEFAULTS.singleCopies;
          person.canvasCache = null;
          setActivePerson(person.id);
        }

        syncDefaultsFormInputs();
        syncCopiesUI();
        scheduleSheetRender();
        showToast('Default settings reset to standard (4 copies · Indian 35×45mm)', 'info');
      } catch (e) {
        console.error(e);
      }
    }

    function initUserDefaults() {
      const d = getUserDefaultSettings();
      AppState.singleCopies = d.singleCopies;
      AppState.paperSize = d.paperSize;
      AppState.orientation = d.orientation;
      AppState.layoutMode = d.layoutMode;
      AppState.sheetMarginMm = d.sheetMarginMm;
      AppState.sheetMarginTopMm = d.sheetMarginTopMm !== undefined ? d.sheetMarginTopMm : d.sheetMarginMm;
      AppState.photoSpacingMm = d.photoSpacingMm;
      AppState.showCutGuides = d.showCutGuides;
      AppState.centerGrid = d.centerGrid;

      syncDefaultsFormInputs();
      updateDefaultsDisplayUI();
    }

    // Global Application State
    const AppState = {
      people: [], // Array of Person entries
      activePersonId: null,
      paperSize: 'A4',
      orientation: 'portrait', // 'portrait' | 'landscape'
      layoutMode: 'single', // 'single' | 'mixed'
      singleCopies: 4, // 4 copies default as requested
      sheetMarginMm: 10,
      sheetMarginTopMm: 10,
      photoSpacingMm: 3,
      showCutGuides: true,
      centerGrid: true,
      activeSheetIndex: 0,
      zoomLevel: 'fit', // 'fit' | 1 | number
      zoomScale: 1.0,
      isPanning: false,
      panStartX: 0,
      panStartY: 0,
      panOffsetX: 0,
      panOffsetY: 0,
    };

    // Cropper instance reference
    let cropperInstance = null;
    let previewDebounceTimer = null;

    // Helper: Convert Millimeters to Pixels at specified DPI
    function mmToPx(mm, dpi = PRINT_DPI) {
      return Math.round((mm / MM_PER_INCH) * dpi);
    }

    // Helper: Generate Unique ID
    function generateId() {
      return 'p_' + Math.random().toString(36).substr(2, 9);
    }

    // Helper: Floating Toast Notification (replaces window.alert for reliable iframe UX)
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      const bg = type === 'error' ? 'bg-rose-600' : type === 'success' ? 'bg-emerald-600' : 'bg-slate-900';
      toast.className = `${bg} text-white text-xs font-semibold px-4 py-3 rounded-lg shadow-xl flex items-center gap-2 pointer-events-auto transition-all duration-300 opacity-0 translate-y-2`;
      toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
      container.appendChild(toast);
      requestAnimationFrame(() => {
        toast.classList.remove('opacity-0', 'translate-y-2');
      });
      setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // Initialize Application
    window.addEventListener('DOMContentLoaded', () => {
      initUserDefaults();
      checkCdnStatus();
      initLucide();
      bindEvents();
      updateUI();
    });

    function checkCdnStatus() {
      if (!window.jspdf || !window.Cropper) {
        const banner = document.getElementById('cdn-warning-banner');
        if (banner) banner.classList.remove('hidden');
      }
    }

    function initLucide() {
      if (window.lucide) {
        window.lucide.createIcons();
      }
    }

    // Create a new Person Entry
    function createPersonEntry(fileOrBlob, fileName, sourceImageElement, dataUrl) {
      const id = generateId();
      let objectUrl = dataUrl || (sourceImageElement && sourceImageElement.src) || '';
      if (!objectUrl && fileOrBlob) {
        try {
          objectUrl = URL.createObjectURL(fileOrBlob);
        } catch (e) {
          objectUrl = '';
        }
      }

      const defaults = getUserDefaultSettings();

      return {
        id,
        name: (fileName.replace(/\.[^/.]+$/, "") || 'Person ' + (AppState.people.length + 1)).slice(0, 60),
        objectUrl,
        imageElement: sourceImageElement,
        originalWidth: sourceImageElement.naturalWidth,
        originalHeight: sourceImageElement.naturalHeight,
        // Settings initialized from user-preserved default presets:
        presetKey: defaults.presetKey || '35x45',
        customWidthMm: defaults.customWidthMm || 35,
        customHeightMm: defaults.customHeightMm || 45,
        rotation: 0, // 0, 90, 180, 270
        brightness: defaults.brightness ?? 100, // 50 - 150
        contrast: defaults.contrast ?? 100, // 50 - 150
        whiteBackground: defaults.whiteBackground !== undefined ? defaults.whiteBackground : true,
        borderThicknessMm: defaults.borderThicknessMm !== undefined ? defaults.borderThicknessMm : 0.3,
        borderColor: defaults.borderColor || '#000000',
        copies: defaults.singleCopies || 4, // for mixed layout
        captionText: '', // Name & date strip text
        cropData: null, // Cropper.js data cache
        canvasCache: null // Processed high-res canvas cache
      };
    }

    // Get Active Person
    function getActivePerson() {
      return AppState.people.find(p => p.id === AppState.activePersonId) || null;
    }

    // Get Current Photo Physical Dimensions for active person
    function getPersonDimensions(person) {
      if (!person) return { width: 32, height: 41.14 };
      if (person.presetKey === 'custom') {
        return {
          width: clampNum(person.customWidthMm, 15, 150, 32),
          height: clampNum(person.customHeightMm, 15, 150, 41.14)
        };
      }
      const preset = PRESET_DIMS[person.presetKey] || PRESET_DIMS['a4_6per_row'];
      return { width: preset.width, height: preset.height };
    }

    // Bind All Event Handlers
    function bindEvents() {
      // Tab Navigation
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const targetTab = btn.getAttribute('data-tab');
          switchTab(targetTab);
        });
      });

      // File Upload Elements & Direct Trigger Handlers
      const fileInput = document.getElementById('file-input');
      const dropZone = document.getElementById('drop-zone');
      const btnSampleTrigger = document.getElementById('btn-sample-trigger');

      function triggerBrowsePhotos() {
        if (!fileInput) return;
        fileInput.value = '';
        fileInput.click();
      }

      // Explicit click triggers for all Browse/Upload buttons across the UI
      const browseButtonIds = [
        'btn-browse-trigger',
        'btn-add-more',
        'btn-upload-in-editor',
        'btn-upload-canvas'
      ];

      browseButtonIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerBrowsePhotos();
          });
        }
      });

      // Prevent Sample button from triggering file upload
      if (btnSampleTrigger) {
        btnSampleTrigger.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          loadSamplePortrait();
        });
      }

      if (fileInput) {
        fileInput.addEventListener('change', (e) => {
          if (e.target.files && e.target.files.length > 0) {
            handleUploadedFiles(e.target.files);
          }
        });
      }

      // Drag and Drop support on the drop-zone
      if (dropZone) {
        ['dragenter', 'dragover'].forEach(name => {
          dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('border-indigo-600', 'bg-indigo-50/50');
          });
        });
        ['dragleave', 'drop'].forEach(name => {
          dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('border-indigo-600', 'bg-indigo-50/50');
          });
        });
        dropZone.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropZone.classList.remove('border-indigo-600', 'bg-indigo-50/50');
          if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleUploadedFiles(e.dataTransfer.files);
          }
        });
      }

      // Clipboard Paste Support (Ctrl+V / Cmd+V)
      window.addEventListener('paste', (e) => {
        if (!e.clipboardData) return;
        const files = [];
        if (e.clipboardData.files && e.clipboardData.files.length > 0) {
          for (let i = 0; i < e.clipboardData.files.length; i++) {
            files.push(e.clipboardData.files[i]);
          }
        } else if (e.clipboardData.items) {
          for (let i = 0; i < e.clipboardData.items.length; i++) {
            const item = e.clipboardData.items[i];
            if (item.type && item.type.indexOf('image') !== -1) {
              const f = item.getAsFile();
              if (f) files.push(f);
            }
          }
        }
        if (files.length > 0) {
          handleUploadedFiles(files);
        }
      });

      // Sample Photo Loaders
      const sampleButtons = ['btn-sample-trigger', 'btn-load-sample-in-editor', 'btn-load-sample-canvas'];
      sampleButtons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            loadSamplePortrait();
          });
        }
      });

      // Clear All
      const btnClearAll = document.getElementById('btn-clear-all');
      const modalClear = document.getElementById('modal-confirm-clear');
      const btnConfirmClear = document.getElementById('btn-confirm-clear-action');
      if (btnClearAll) btnClearAll.addEventListener('click', () => modalClear.showModal());
      if (btnConfirmClear) {
        btnConfirmClear.addEventListener('click', () => {
          clearAllPhotos();
          modalClear.close();
        });
      }

      // Modals: Specs & Print Guide & Default Settings
      const btnBannerGuide = document.getElementById('btn-banner-guide');
      const modalPrintGuide = document.getElementById('modal-print-guide');
      if (btnBannerGuide) btnBannerGuide.addEventListener('click', () => modalPrintGuide.showModal());

      // My Default Settings Modals & Action Buttons
      const modalDefaults = document.getElementById('modal-default-settings');
      const openDefaultsModal = () => {
        updateDefaultsDisplayUI();
        modalDefaults?.showModal();
      };

      
      document.getElementById('btn-open-defaults-modal')?.addEventListener('click', openDefaultsModal);

      document.getElementById('btn-quick-save-defaults')?.addEventListener('click', () => {
        saveCurrentStateAsDefault(true);
      });

      document.getElementById('btn-save-as-default-preset')?.addEventListener('click', () => {
        saveCurrentStateAsDefault(true);
      });

      document.getElementById('btn-save-as-default-copies')?.addEventListener('click', () => {
        saveCurrentStateAsDefault(true);
      });

      document.getElementById('btn-save-current-as-defaults-modal')?.addEventListener('click', () => {
        saveCurrentStateAsDefault(true);
      });

      document.getElementById('btn-apply-defaults-to-photo')?.addEventListener('click', () => {
        applySavedDefaultsToActivePhoto();
      });

      document.getElementById('btn-reset-factory-defaults')?.addEventListener('click', () => {
        resetUserDefaultSettings();
      });

      document.getElementById('toggle-auto-preserve')?.addEventListener('change', (e) => {
        saveUserDefaultSettings({ autoPreserve: e.target.checked });
        showToast(e.target.checked ? 'Auto-preserve active for future photos' : 'Auto-preserve disabled', 'info');
      });

      document.querySelectorAll('.btn-close-modal').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('dialog').forEach(d => d.close());
        });
      });

      // Cropper Controls

      document.getElementById('btn-crop-zoom-in')?.addEventListener('click', () => cropperInstance?.zoom(0.1));
      document.getElementById('btn-crop-zoom-out')?.addEventListener('click', () => cropperInstance?.zoom(-0.1));
      document.getElementById('btn-rotate-ccw')?.addEventListener('click', () => rotateActivePhoto(-90));
      document.getElementById('btn-rotate-cw')?.addEventListener('click', () => rotateActivePhoto(90));
      document.getElementById('btn-crop-reset')?.addEventListener('click', resetActiveCrop);

      // Aspect Ratio Lock Toggle
      document.getElementById('toggle-lock-ratio')?.addEventListener('change', (e) => {
        if (!cropperInstance) return;
        const person = getActivePerson();
        if (e.target.checked) {
          const dims = getPersonDimensions(person);
          cropperInstance.setAspectRatio(dims.width / dims.height);
        } else {
          cropperInstance.setAspectRatio(NaN); // Unlocked freeform crop
        }
      });

      // Face Guide Toggle
      document.getElementById('toggle-face-guide')?.addEventListener('change', updateFaceGuideOverlay);

      // Preset Selector
      const selectPreset = document.getElementById('select-preset');
      if (selectPreset) {
        selectPreset.addEventListener('change', (e) => {
          const person = getActivePerson();
          if (!person) return;
          person.presetKey = e.target.value;
          const isCustom = person.presetKey === 'custom';
          document.getElementById('custom-dimension-inputs')?.classList.toggle('hidden', !isCustom);

          if (person.presetKey === 'a4_6per_row') {
            AppState.sheetMarginMm = 2.57;
            AppState.sheetMarginTopMm = 10;
            AppState.photoSpacingMm = 2.57;
            document.getElementById('input-sheet-margin').value = '2.57';
            document.getElementById('input-sheet-margin-top').value = '10';
            document.getElementById('input-photo-spacing').value = '2.57';
          } else if (person.presetKey === '35x45') {
            AppState.sheetMarginMm = 10;
            AppState.sheetMarginTopMm = 10;
            AppState.photoSpacingMm = 3;
            document.getElementById('input-sheet-margin').value = '10';
            document.getElementById('input-sheet-margin-top').value = '10';
            document.getElementById('input-photo-spacing').value = '3';
          }

          autoPreserveSetting({
            presetKey: person.presetKey,
            sheetMarginMm: AppState.sheetMarginMm,
            photoSpacingMm: AppState.photoSpacingMm
          });

          applyPresetToCropper(person);
          scheduleSheetRender();
        });
      }

      // Custom Dimension inputs
      ['custom-width-mm', 'custom-height-mm'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
          const person = getActivePerson();
          if (!person) return;
          person.customWidthMm = clampNum(document.getElementById('custom-width-mm').value, 15, 150, 35);
          person.customHeightMm = clampNum(document.getElementById('custom-height-mm').value, 15, 150, 45);
          autoPreserveSetting({
            presetKey: 'custom',
            customWidthMm: person.customWidthMm,
            customHeightMm: person.customHeightMm
          });
          applyPresetToCropper(person);
          scheduleSheetRender();
        });
      });

      // Image Adjustments Sliders
      const sliderBrightness = document.getElementById('slider-brightness');
      const sliderContrast = document.getElementById('slider-contrast');
      const toggleWhiteBg = document.getElementById('toggle-white-bg');
      const btnResetAdj = document.getElementById('btn-reset-adjustments');

      sliderBrightness?.addEventListener('input', (e) => {
        const person = getActivePerson();
        if (!person) return;
        person.brightness = parseInt(e.target.value, 10);
        document.getElementById('brightness-val').textContent = person.brightness + '%';
        person.canvasCache = null;
        autoPreserveSetting({ brightness: person.brightness });
        scheduleSheetRender();
      });

      sliderContrast?.addEventListener('input', (e) => {
        const person = getActivePerson();
        if (!person) return;
        person.contrast = parseInt(e.target.value, 10);
        document.getElementById('contrast-val').textContent = person.contrast + '%';
        person.canvasCache = null;
        autoPreserveSetting({ contrast: person.contrast });
        scheduleSheetRender();
      });

      toggleWhiteBg?.addEventListener('change', (e) => {
        const person = getActivePerson();
        if (!person) return;
        person.whiteBackground = e.target.checked;
        person.canvasCache = null;
        autoPreserveSetting({ whiteBackground: person.whiteBackground });
        scheduleSheetRender();
      });

      btnResetAdj?.addEventListener('click', () => {
        const person = getActivePerson();
        if (!person) return;
        person.brightness = 100;
        person.contrast = 100;
        person.whiteBackground = true;
        if (sliderBrightness) sliderBrightness.value = '100';
        if (sliderContrast) sliderContrast.value = '100';
        if (toggleWhiteBg) toggleWhiteBg.checked = true;
        document.getElementById('brightness-val').textContent = '100%';
        document.getElementById('contrast-val').textContent = '100%';
        person.canvasCache = null;
        autoPreserveSetting({
          brightness: 100,
          contrast: 100,
          whiteBackground: true
        });
        scheduleSheetRender();
      });

      // Border Controls
      document.getElementById('select-border-thickness')?.addEventListener('change', (e) => {
        const person = getActivePerson();
        if (!person) return;
        person.borderThicknessMm = parseFloat(e.target.value);
        person.canvasCache = null;
        autoPreserveSetting({ borderThicknessMm: person.borderThicknessMm });
        scheduleSheetRender();
      });

      const selectBorderColor = document.getElementById('select-border-color');
      const inputCustomBorderColor = document.getElementById('input-custom-border-color');

      selectBorderColor?.addEventListener('change', (e) => {
        const person = getActivePerson();
        if (!person) return;
        if (e.target.value === 'custom') {
          person.borderColor = inputCustomBorderColor.value;
        } else {
          person.borderColor = e.target.value;
        }
        person.canvasCache = null;
        autoPreserveSetting({ borderColor: person.borderColor });
        scheduleSheetRender();
      });

      inputCustomBorderColor?.addEventListener('input', (e) => {
        const person = getActivePerson();
        if (!person) return;
        person.borderColor = e.target.value;
        if (selectBorderColor) selectBorderColor.value = 'custom';
        person.canvasCache = null;
        autoPreserveSetting({ borderColor: person.borderColor });
        scheduleSheetRender();
      });

      // Paper Settings
      document.getElementById('select-paper-size')?.addEventListener('change', (e) => {
        AppState.paperSize = e.target.value;
        AppState.activeSheetIndex = 0;
        autoPreserveSetting({ paperSize: AppState.paperSize });
        scheduleSheetRender();
      });

      document.getElementById('select-paper-orientation')?.addEventListener('change', (e) => {
        AppState.orientation = e.target.value;
        AppState.activeSheetIndex = 0;
        autoPreserveSetting({ orientation: AppState.orientation });
        scheduleSheetRender();
      });

      // Layout Mode Radio
      document.querySelectorAll('input[name="layout-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
          AppState.layoutMode = e.target.value;
          document.getElementById('single-mode-controls')?.classList.toggle('hidden', AppState.layoutMode !== 'single');
          document.getElementById('mixed-mode-controls')?.classList.toggle('hidden', AppState.layoutMode !== 'mixed');
          AppState.activeSheetIndex = 0;
          autoPreserveSetting({ layoutMode: AppState.layoutMode });
          scheduleSheetRender();
        });
      });

      // Single Mode Preset Buttons
      document.querySelectorAll('.btn-copy-preset').forEach(btn => {
        btn.addEventListener('click', () => {
          const copies = parseInt(btn.getAttribute('data-copies'), 10);
          AppState.singleCopies = copies;
          const person = getActivePerson();
          if (person) person.copies = copies;
          syncCopiesUI();
          autoPreserveSetting({ singleCopies: copies });
          scheduleSheetRender();
        });
      });

      document.getElementById('input-custom-copies')?.addEventListener('input', (e) => {
        const val = Math.max(1, Math.min(MAX_COPIES, parseInt(e.target.value, 10) || 1));
        AppState.singleCopies = val;
        const person = getActivePerson();
        if (person) person.copies = val;
        syncCopiesUI();
        autoPreserveSetting({ singleCopies: val });
        scheduleSheetRender();
      });

      // Stepper button listeners (+ / - buttons)
      document.getElementById('btn-copy-minus')?.addEventListener('click', () => changeSingleCopies(-1));
      document.getElementById('btn-copy-plus')?.addEventListener('click', () => changeSingleCopies(1));
      document.getElementById('btn-minus-row')?.addEventListener('click', () => changeSingleCopies(-6));
      document.getElementById('btn-add-row')?.addEventListener('click', () => changeSingleCopies(6));

      // Live Workspace Top Bar Steppers
      document.getElementById('btn-quick-minus')?.addEventListener('click', () => changeSingleCopies(-1));
      document.getElementById('btn-quick-plus')?.addEventListener('click', () => changeSingleCopies(1));
      document.getElementById('btn-quick-add-row')?.addEventListener('click', () => changeSingleCopies(6));

      document.getElementById('btn-fill-max')?.addEventListener('click', () => {
        const capacity = calculateCurrentSheetCapacity();
        if (capacity > 0) {
          AppState.singleCopies = capacity;
          const person = getActivePerson();
          if (person) person.copies = capacity;
          syncCopiesUI();
          autoPreserveSetting({ singleCopies: capacity });
          scheduleSheetRender();
        }
      });

      // Margins and Spacing
      document.getElementById('input-sheet-margin')?.addEventListener('input', (e) => {
        AppState.sheetMarginMm = clampNum(e.target.value, 0.5, 60, 2.57);
        autoPreserveSetting({ sheetMarginMm: AppState.sheetMarginMm });
        scheduleSheetRender();
      });

      document.getElementById('input-sheet-margin-top')?.addEventListener('input', (e) => {
        AppState.sheetMarginTopMm = clampNum(e.target.value, 0, 100, 0);
        autoPreserveSetting({ sheetMarginTopMm: AppState.sheetMarginTopMm });
        scheduleSheetRender();
      });

      // Name & Date on Photo
      const inputPhotoText = document.getElementById('input-photo-text');
      inputPhotoText?.addEventListener('input', (e) => {
        const person = getActivePerson();
        if (!person) return;
        person.captionText = String(e.target.value).slice(0, 200);
        person.canvasCache = null;
        updateCropCaptionOverlay();
        scheduleSheetRender();
      });

      document.getElementById('btn-insert-today-date')?.addEventListener('click', () => {
        const person = getActivePerson();
        if (!person || !inputPhotoText) return;
        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        const dateStr = `DOO: ${day}/${month}/${year}`;

        if (!inputPhotoText.value.trim()) {
          inputPhotoText.value = (person.name && !person.name.startsWith('Person ') && !person.name.startsWith('Photo ')) 
            ? `${person.name.toUpperCase()}\n${dateStr}` 
            : dateStr;
        } else if (!inputPhotoText.value.includes(dateStr)) {
          inputPhotoText.value = inputPhotoText.value.trim() + '\n' + dateStr;
        }
        person.captionText = inputPhotoText.value;
        person.canvasCache = null;
        updateCropCaptionOverlay();
        scheduleSheetRender();
      });

      document.getElementById('btn-clear-photo-text')?.addEventListener('click', () => {
        const person = getActivePerson();
        if (!person || !inputPhotoText) return;
        inputPhotoText.value = '';
        person.captionText = '';
        person.canvasCache = null;
        updateCropCaptionOverlay();
        scheduleSheetRender();
      });

      document.getElementById('input-photo-spacing')?.addEventListener('input', (e) => {
        AppState.photoSpacingMm = clampNum(e.target.value, 0, 25, 0);
        autoPreserveSetting({ photoSpacingMm: AppState.photoSpacingMm });
        scheduleSheetRender();
      });

      document.getElementById('toggle-cut-guides')?.addEventListener('change', (e) => {
        AppState.showCutGuides = e.target.checked;
        autoPreserveSetting({ showCutGuides: AppState.showCutGuides });
        scheduleSheetRender();
      });

      document.getElementById('toggle-center-grid')?.addEventListener('change', (e) => {
        AppState.centerGrid = e.target.checked;
        autoPreserveSetting({ centerGrid: AppState.centerGrid });
        scheduleSheetRender();
      });

      document.getElementById('btn-reset-spacing')?.addEventListener('click', () => {
        const person = getActivePerson();
        if (person && person.presetKey === 'a4_6per_row') {
          AppState.sheetMarginMm = 2.57;
          AppState.sheetMarginTopMm = 10;
          AppState.photoSpacingMm = 2.57;
          document.getElementById('input-sheet-margin').value = '2.57';
          document.getElementById('input-sheet-margin-top').value = '10';
          document.getElementById('input-photo-spacing').value = '2.57';
        } else {
          AppState.sheetMarginMm = 10;
          AppState.sheetMarginTopMm = 10;
          AppState.photoSpacingMm = 3;
          document.getElementById('input-sheet-margin').value = '10';
          document.getElementById('input-sheet-margin-top').value = '10';
          document.getElementById('input-photo-spacing').value = '3';
        }
        AppState.showCutGuides = true;
        AppState.centerGrid = true;
        document.getElementById('toggle-cut-guides').checked = true;
        document.getElementById('toggle-center-grid').checked = true;
        scheduleSheetRender();
      });

      // Rename Active Person (Via Accessible Modal Dialog, avoiding window.prompt)
      const modalRename = document.getElementById('modal-rename');
      const inputRename = document.getElementById('input-rename-person');
      const formRename = document.getElementById('form-rename');

      document.getElementById('btn-rename-active')?.addEventListener('click', () => {
        const person = getActivePerson();
        if (!person || !modalRename || !inputRename) return;
        inputRename.value = person.name;
        modalRename.showModal();
        setTimeout(() => inputRename.focus(), 50);
      });

      formRename?.addEventListener('submit', (e) => {
        e.preventDefault();
        const person = getActivePerson();
        if (person && inputRename && inputRename.value.trim()) {
          person.name = inputRename.value.trim().slice(0, 60);
          document.getElementById('active-person-name').textContent = person.name;
          renderPeopleList();
          showToast(`Updated name to "${person.name}"`, 'info');
        }
        modalRename?.close();
      });

      document.getElementById('btn-switch-to-lib')?.addEventListener('click', () => {
        switchTab('tab-photos');
      });

      // Zoom Controls for Sheet Preview
      document.getElementById('btn-zoom-in')?.addEventListener('click', () => changeZoom(0.15));
      document.getElementById('btn-zoom-out')?.addEventListener('click', () => changeZoom(-0.15));
      document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
        AppState.zoomLevel = 'fit';
        AppState.panOffsetX = 0;
        AppState.panOffsetY = 0;
        applyCanvasTransform();
      });
      document.getElementById('btn-zoom-100')?.addEventListener('click', () => {
        AppState.zoomLevel = 1.0;
        AppState.zoomScale = 1.0;
        AppState.panOffsetX = 0;
        AppState.panOffsetY = 0;
        applyCanvasTransform();
      });

      // Pan Interaction on Viewport
      const viewport = document.getElementById('preview-viewport');
      if (viewport) {
        viewport.addEventListener('mousedown', (e) => {
          if (e.target.closest('button') || e.target.closest('#canvas-empty-overlay')) return;
          AppState.isPanning = true;
          AppState.panStartX = e.clientX - AppState.panOffsetX;
          AppState.panStartY = e.clientY - AppState.panOffsetY;
        });
        window.addEventListener('mousemove', (e) => {
          if (!AppState.isPanning) return;
          AppState.panOffsetX = e.clientX - AppState.panStartX;
          AppState.panOffsetY = e.clientY - AppState.panStartY;
          applyCanvasTransform();
        });
        window.addEventListener('mouseup', () => {
          AppState.isPanning = false;
        });

        // Touch support for Pan
        viewport.addEventListener('touchstart', (e) => {
          if (e.touches.length === 1) {
            AppState.isPanning = true;
            AppState.panStartX = e.touches[0].clientX - AppState.panOffsetX;
            AppState.panStartY = e.touches[0].clientY - AppState.panOffsetY;
          }
        }, { passive: true });
        window.addEventListener('touchmove', (e) => {
          if (!AppState.isPanning || e.touches.length !== 1) return;
          AppState.panOffsetX = e.touches[0].clientX - AppState.panStartX;
          AppState.panOffsetY = e.touches[0].clientY - AppState.panStartY;
          applyCanvasTransform();
        }, { passive: true });
        window.addEventListener('touchend', () => {
          AppState.isPanning = false;
        });
      }

      // Pagination Controls
      document.getElementById('btn-prev-page')?.addEventListener('click', () => {
        if (AppState.activeSheetIndex > 0) {
          AppState.activeSheetIndex--;
          scheduleSheetRender();
        }
      });
      document.getElementById('btn-next-page')?.addEventListener('click', () => {
        const totalSheets = calculateTotalSheets();
        if (AppState.activeSheetIndex < totalSheets - 1) {
          AppState.activeSheetIndex++;
          scheduleSheetRender();
        }
      });

      // Export Buttons
      document.getElementById('btn-export-pdf')?.addEventListener('click', exportPDF);
      document.getElementById('btn-export-jpeg')?.addEventListener('click', () => exportImage('jpeg'));
      document.getElementById('btn-export-png')?.addEventListener('click', () => exportImage('png'));
      document.getElementById('btn-export-single')?.addEventListener('click', exportSinglePhoto);

      // Window resize
      window.addEventListener('resize', () => {
        if (AppState.zoomLevel === 'fit') {
          applyCanvasTransform();
        }
      });
    }

    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-tab') === tabId;
        btn.classList.toggle('bg-indigo-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('shadow-sm', isActive);
        btn.classList.toggle('text-slate-600', !isActive);
      });
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('hidden', content.id !== tabId);
      });

      // If switching to crop tab, ensure cropper is sized
      if (tabId === 'tab-crop' && cropperInstance) {
        setTimeout(() => {
          cropperInstance.resize();
        }, 50);
      }
    }

    function highlightCopyPresetButton(copies) {
      document.querySelectorAll('.btn-copy-preset').forEach(btn => {
        const c = parseInt(btn.getAttribute('data-copies'), 10);
        const isMatch = c === copies;
        btn.classList.toggle('border-indigo-600', isMatch);
        btn.classList.toggle('bg-indigo-50', isMatch);
        btn.classList.toggle('text-indigo-700', isMatch);
        btn.classList.toggle('border-slate-200', !isMatch);
        btn.classList.toggle('text-slate-700', !isMatch);
      });
    }

    function changeSingleCopies(delta) {
      const current = AppState.singleCopies || 1;
      const newCount = Math.max(1, Math.min(MAX_COPIES, current + delta));
      AppState.singleCopies = newCount;
      const person = getActivePerson();
      if (person) person.copies = newCount;
      syncCopiesUI();
      autoPreserveSetting({ singleCopies: newCount });
      scheduleSheetRender();
    }

    function syncCopiesUI() {
      const val = AppState.singleCopies || 1;
      const input = document.getElementById('input-custom-copies');
      if (input) input.value = val;
      const quickDisplay = document.getElementById('quick-copies-display');
      if (quickDisplay) quickDisplay.textContent = val.toString();
      highlightCopyPresetButton(val);
      renderPeopleList();
    }

    // Handle Uploaded Files
    async function handleUploadedFiles(fileList) {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      const remainingSlots = MAX_PEOPLE - AppState.people.length;

      if (remainingSlots <= 0) {
        showToast('Maximum of ' + MAX_PEOPLE + ' people reached. Please delete an entry before adding more.', 'error');
        return;
      }

      const filesToProcess = files.slice(0, remainingSlots);
      let addedCount = 0;

      for (const file of filesToProcess) {
        const fileName = String(file.name || ('Photo ' + (AppState.people.length + 1))).replace(/[\u0000-\u001f<>"]/g, '').slice(0, 80) || ('Photo ' + (AppState.people.length + 1));
        
        // Strict validation: real file CONTENT must be JPEG, PNG, WebP or HEIC/HEIF
        const kind = await sniffImageKind(file).catch(() => null);
        if (!kind) {
          showToast(`"${fileName}" is not a supported image. Please choose a JPG, JPEG, PNG, WebP or HEIC photo.`, 'error');
          continue;
        }

        if (file.size && file.size > MAX_UPLOAD_BYTES) {
          showToast(`"${fileName}" is larger than 25MB. Please choose a smaller photo.`, 'error');
          continue;
        }

        try {
          const img = await decodeImageFile(file);
          const person = createPersonEntry(file, fileName, img);
          AppState.people.push(person);
          addedCount++;

          if (!AppState.activePersonId) {
            AppState.activePersonId = person.id;
          }
        } catch (err) {
          console.error('File decode failure:', err);
          showToast(`Could not decode "${fileName}". The file may be corrupt or unreadable.`, 'error');
        }
      }

      if (addedCount > 0) {
        const d = getUserDefaultSettings();
        const presetName = getPresetShortName(d.presetKey, d.customWidthMm, d.customHeightMm);
        showToast(`Added ${addedCount} photo${addedCount > 1 ? 's' : ''} with your defaults (${d.singleCopies} copies · ${presetName})`, 'success');
        updateUI();
        setActivePerson(AppState.people[AppState.people.length - 1].id);
        switchTab('tab-crop');
      }
    }

    // Decode Image File safely (HEIC fallback + pixel-count guard)
    async function decodeImageFile(file) {
      let img;
      try {
        img = await decodeImageFileRaw(file);
      } catch (firstErr) {
        const kind = await sniffImageKind(file).catch(() => null);
        if (kind !== 'heic') throw firstErr;
        const convert = await loadHeic2Any();
        let out = await convert({ blob: file, toType: 'image/jpeg', quality: 0.92 });
        if (Array.isArray(out)) out = out[0];
        img = await decodeImageFileRaw(out);
      }
      const pixels = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      if (pixels < 1 || pixels > MAX_IMAGE_PIXELS) {
        try { URL.revokeObjectURL(img.src); } catch (_) {}
        throw new Error('Image dimensions are not supported');
      }
      return img;
    }

    function decodeImageFileRaw(file) {
      return new Promise((resolve, reject) => {
        let url = '';
        try {
          url = URL.createObjectURL(file);
        } catch (e) {
          return reject(e);
        }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Image decode error'));
        };
        img.src = url;
      });
    }

    // Load High Quality Synthetic / Demo Portrait
    function loadSamplePortrait() {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 1500;
      const ctx = canvas.getContext('2d');

      // Studio Gradient Background (Off-white / Light studio gray)
      const grad = ctx.createLinearGradient(0, 0, 0, 1500);
      grad.addColorStop(0, '#f8fafc');
      grad.addColorStop(0.5, '#f1f5f9');
      grad.addColorStop(1, '#e2e8f0');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1200, 1500);

      // Shoulders / Dark Studio Blazer
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.ellipse(600, 1500, 480, 520, 0, 0, Math.PI * 2);
      ctx.fill();

      // White Shirt Collar
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(520, 1060);
      ctx.lineTo(600, 1240);
      ctx.lineTo(680, 1060);
      ctx.closePath();
      ctx.fill();

      // Neck
      ctx.fillStyle = '#f6d1b8';
      ctx.beginPath();
      ctx.ellipse(600, 1020, 130, 170, 0, 0, Math.PI * 2);
      ctx.fill();

      // Face Head Shape
      ctx.fillStyle = '#fed7aa';
      ctx.beginPath();
      ctx.ellipse(600, 680, 260, 340, 0, 0, Math.PI * 2);
      ctx.fill();

      // Ears
      ctx.fillStyle = '#fdba74';
      ctx.beginPath();
      ctx.ellipse(335, 680, 40, 75, 0, 0, Math.PI * 2);
      ctx.ellipse(865, 680, 40, 75, 0, 0, Math.PI * 2);
      ctx.fill();

      // Professional Hairstyle
      ctx.fillStyle = '#331e11';
      ctx.beginPath();
      ctx.ellipse(600, 450, 275, 180, 0, 0, Math.PI * 2);
      ctx.fill();

      // Eyes
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(490, 660, 36, 18, 0, 0, Math.PI * 2);
      ctx.ellipse(710, 660, 36, 18, 0, 0, Math.PI * 2);
      ctx.fill();

      // Irises (Dark Brown)
      ctx.fillStyle = '#3b2512';
      ctx.beginPath();
      ctx.arc(490, 660, 16, 0, Math.PI * 2);
      ctx.arc(710, 660, 16, 0, Math.PI * 2);
      ctx.fill();

      // Catchlights
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(486, 656, 5, 0, Math.PI * 2);
      ctx.arc(706, 656, 5, 0, Math.PI * 2);
      ctx.fill();

      // Eyebrows
      ctx.strokeStyle = '#29180c';
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(445, 620);
      ctx.quadraticCurveTo(490, 605, 545, 620);
      ctx.moveTo(655, 620);
      ctx.quadraticCurveTo(710, 605, 755, 620);
      ctx.stroke();

      // Nose
      ctx.strokeStyle = '#ea580c';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(600, 670);
      ctx.lineTo(600, 760);
      ctx.lineTo(625, 775);
      ctx.stroke();

      // Neutral Friendly Lips (ICAO Passport compliant neutral expression)
      ctx.strokeStyle = '#be123c';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(535, 850);
      ctx.quadraticCurveTo(600, 858, 665, 850);
      ctx.stroke();

      canvas.toBlob((blob) => {
        if (!blob) return;
        const img = new Image();
        img.onload = () => {
          const person = createPersonEntry(blob, 'Sample Studio Portrait.jpg', img);
          AppState.people.push(person);
          setActivePerson(person.id);
          updateUI();
          switchTab('tab-crop');
          const d = getUserDefaultSettings();
          const presetName = getPresetShortName(d.presetKey, d.customWidthMm, d.customHeightMm);
          showToast(`Sample photo loaded with your defaults (${d.singleCopies} copies · ${presetName})`, 'info');
        };
        img.src = URL.createObjectURL(blob);
      }, 'image/jpeg', 0.95);
    }

    // Set Active Person in Workspace
    function setActivePerson(id) {
      // Save current crop data if exists
      const oldPerson = getActivePerson();
      if (oldPerson && cropperInstance) {
        oldPerson.cropData = cropperInstance.getData();
      }

      AppState.activePersonId = id;
      const person = getActivePerson();
      if (!person) return;

      // Update UI components for active person
      document.getElementById('active-person-name').textContent = person.name;
      const dims = getPersonDimensions(person);
      document.getElementById('active-person-meta').textContent = `${dims.width} × ${dims.height} mm · ${person.originalWidth}×${person.originalHeight}px`;

      // Update thumbnail
      const thumb = document.getElementById('active-person-thumb');
      thumb.innerHTML = `<img src="${safeImgSrc(person.objectUrl)}" class="w-full h-full object-cover" />`;

      // Preset Selector
      const selectPreset = document.getElementById('select-preset');
      if (selectPreset) selectPreset.value = person.presetKey;
      document.getElementById('custom-dimension-inputs')?.classList.toggle('hidden', person.presetKey !== 'custom');
      document.getElementById('custom-width-mm').value = person.customWidthMm;
      document.getElementById('custom-height-mm').value = person.customHeightMm;

      // Sliders
      document.getElementById('slider-brightness').value = person.brightness;
      document.getElementById('brightness-val').textContent = person.brightness + '%';
      document.getElementById('slider-contrast').value = person.contrast;
      document.getElementById('contrast-val').textContent = person.contrast + '%';
      document.getElementById('toggle-white-bg').checked = person.whiteBackground;

      // Border controls
      document.getElementById('select-border-thickness').value = person.borderThicknessMm.toString();
      const selectBorderColor = document.getElementById('select-border-color');
      if (['#000000', '#D1D5DB'].includes(person.borderColor)) {
        selectBorderColor.value = person.borderColor;
      } else {
        selectBorderColor.value = 'custom';
        document.getElementById('input-custom-border-color').value = person.borderColor;
      }

      // Sync copies UI if single mode
      if (AppState.layoutMode === 'single') {
        AppState.singleCopies = person.copies || AppState.singleCopies || 4;
        syncCopiesUI();
      }

      // Sync Photo Name / Date Text
      const inputPhotoText = document.getElementById('input-photo-text');
      if (inputPhotoText) inputPhotoText.value = person.captionText || '';
      updateCropCaptionOverlay();

      // Initialize or Update Cropper.js
      initCropperForPerson(person);
      renderPeopleList();
      scheduleSheetRender();
    }

    // Initialize or rebind Cropper.js for a person
    function initCropperForPerson(person) {
      const imageEl = document.getElementById('cropper-image');
      const placeholder = document.getElementById('cropper-placeholder');

      if (!person || !person.objectUrl) {
        if (cropperInstance) cropperInstance.destroy();
        cropperInstance = null;
        imageEl.classList.add('opacity-0');
        placeholder?.classList.remove('hidden');
        return;
      }

      placeholder?.classList.add('hidden');
      imageEl.classList.remove('opacity-0');

      if (cropperInstance) {
        cropperInstance.destroy();
        cropperInstance = null;
      }

      imageEl.src = person.objectUrl;

      const dims = getPersonDimensions(person);
      const targetAspectRatio = dims.width / dims.height;

      // Update label
      document.getElementById('crop-dimension-label').textContent = `${dims.width} × ${dims.height} mm`;

      if (window.Cropper) {
        cropperInstance = new Cropper(imageEl, {
          aspectRatio: targetAspectRatio,
          viewMode: 1, // Restrict crop box to container
          dragMode: 'move',
          autoCropArea: 0.85,
          restore: false,
          guides: true,
          center: true,
          highlight: false,
          cropBoxMovable: true,
          cropBoxResizable: true,
          toggleDragModeOnDblclick: false,
          ready() {
            // Apply cached rotation and cropData if available
            if (person.rotation !== 0) {
              cropperInstance.rotateTo(person.rotation);
            }
            if (person.cropData) {
              cropperInstance.setData(person.cropData);
              updateFaceGuideOverlay();
            } else {
              updateFaceGuideOverlay();
            }
            updateCropCaptionOverlay();
          },
          cropend() {
            person.cropData = cropperInstance.getData();
            person.canvasCache = null;
            updateFaceGuideOverlay();
            updateCropCaptionOverlay();
            scheduleSheetRender();
          },
          zoom() {
            person.cropData = cropperInstance?.getData();
            person.canvasCache = null;
            updateFaceGuideOverlay();
            updateCropCaptionOverlay();
            scheduleSheetRender();
          }
        });
      }
    }

    function updateFaceGuideOverlay() {
      const overlay = document.getElementById('face-guide-overlay');
      const toggle = document.getElementById('toggle-face-guide');
      if (!overlay || !toggle) return;

      if (!toggle.checked) {
        overlay.classList.add('hidden');
        return;
      }

      const cropBox = document.querySelector('.cropper-crop-box');
      if (cropBox) {
        if (overlay.parentElement !== cropBox) {
          cropBox.appendChild(overlay);
        }
        overlay.classList.remove('hidden');
        overlay.style.position = 'absolute';
        overlay.style.inset = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '10';
      } else {
        overlay.classList.remove('hidden');
      }
    }

    function updateCropCaptionOverlay() {
      const cropBox = document.querySelector('.cropper-crop-box');
      let captionOverlay = document.getElementById('crop-caption-overlay');
      const person = getActivePerson();
      const hasText = !!(person && person.captionText && person.captionText.trim());

      if (!hasText) {
        if (captionOverlay) captionOverlay.classList.add('hidden');
        return;
      }

      if (!captionOverlay) {
        captionOverlay = document.createElement('div');
        captionOverlay.id = 'crop-caption-overlay';
        captionOverlay.className = 'absolute bottom-0 inset-x-0 bg-white/95 text-slate-900 border-t border-slate-300 font-mono text-[9px] font-bold text-center py-0.5 px-1 pointer-events-none select-none z-20 flex flex-col items-center justify-center shadow-xs';
      }

      if (cropBox && captionOverlay.parentElement !== cropBox) {
        cropBox.appendChild(captionOverlay);
      }

      const lines = person.captionText.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5);
      captionOverlay.innerHTML = lines.map(l => `<div class="truncate max-w-full leading-tight">${escapeHtml(l)}</div>`).join('');
      captionOverlay.classList.remove('hidden');
    }

    function applyPresetToCropper(person) {
      if (!person) return;
      const dims = getPersonDimensions(person);
      document.getElementById('crop-dimension-label').textContent = `${dims.width} × ${dims.height} mm`;
      document.getElementById('active-person-meta').textContent = `${dims.width} × ${dims.height} mm · ${person.originalWidth}×${person.originalHeight}px`;

      if (cropperInstance) {
        cropperInstance.setAspectRatio(dims.width / dims.height);
        person.cropData = cropperInstance.getData();
      }
      person.canvasCache = null;
    }

    function rotateActivePhoto(degrees) {
      const person = getActivePerson();
      if (!person) return;
      person.rotation = (person.rotation + degrees + 360) % 360;
      if (cropperInstance) {
        cropperInstance.rotate(degrees);
        person.cropData = cropperInstance.getData();
      }
      person.canvasCache = null;
      scheduleSheetRender();
    }

    function resetActiveCrop() {
      const person = getActivePerson();
      if (!person) return;
      person.rotation = 0;
      if (cropperInstance) {
        cropperInstance.reset();
        person.cropData = cropperInstance.getData();
      }
      person.canvasCache = null;
      scheduleSheetRender();
    }

    // Render People List (Photos section)
    function renderPeopleList() {
      const listEl = document.getElementById('people-list');
      const emptyEl = document.getElementById('library-empty-state');
      const badge = document.getElementById('photo-count-badge');
      const countText = document.getElementById('lib-count-text');

      badge.textContent = AppState.people.length.toString();
      countText.textContent = `(${AppState.people.length} of ${MAX_PEOPLE})`;

      if (AppState.people.length === 0) {
        emptyEl.classList.remove('hidden');
        listEl.innerHTML = '';
        return;
      }

      emptyEl.classList.add('hidden');
      listEl.innerHTML = '';

      AppState.people.forEach((p, idx) => {
        const isSelected = p.id === AppState.activePersonId;
        const dims = getPersonDimensions(p);

        const card = document.createElement('div');
        card.className = `p-2.5 rounded-lg border transition-all flex items-center justify-between gap-3 ${
          isSelected
            ? 'bg-indigo-50/70 border-indigo-400 shadow-xs'
            : 'bg-white border-slate-200 hover:border-slate-300'
        }`;

        card.innerHTML = `
          <div class="flex items-center gap-2.5 overflow-hidden cursor-pointer flex-1">
            <div class="w-10 h-10 rounded bg-slate-100 border border-slate-200 overflow-hidden shrink-0">
              <img src="${safeImgSrc(p.objectUrl)}" class="w-full h-full object-cover" />
            </div>
            <div class="truncate">
              <h4 class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(p.name)}</h4>
              <p class="text-[11px] text-slate-500 font-mono">${dims.width} × ${dims.height} mm</p>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <!-- Stepper to add more or less copies or delete -->
            <div class="flex items-center border border-slate-300 rounded bg-white overflow-hidden text-xs shadow-2xs">
              <button type="button" class="btn-card-minus w-5 h-6 text-slate-700 hover:bg-slate-100 active:bg-slate-200 font-bold flex items-center justify-center select-none" title="Decrease copies or delete if 1">
                −
              </button>
              <span class="px-1 font-mono font-bold text-slate-800 text-[11px] tabular-nums min-w-[18px] text-center">${p.copies || 6}</span>
              <button type="button" class="btn-card-plus w-5 h-6 text-slate-700 hover:bg-slate-100 active:bg-slate-200 font-bold flex items-center justify-center select-none" title="Add copies (+1)">
                +
              </button>
            </div>
            <button type="button" class="btn-dup p-1 text-slate-400 hover:text-indigo-600 rounded" title="Duplicate Person">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            </button>
            <button type="button" class="btn-del p-1 text-slate-400 hover:text-rose-600 rounded" title="Delete Person">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        `;

        // Card select click
        card.querySelector('.flex-1').addEventListener('click', () => {
          setActivePerson(p.id);
          switchTab('tab-crop');
        });

        // Card minus (decrease copies or delete)
        card.querySelector('.btn-card-minus').addEventListener('click', (e) => {
          e.stopPropagation();
          if ((p.copies || 1) <= 1) {
            deletePerson(p.id);
          } else {
            p.copies = (p.copies || 1) - 1;
            if (p.id === AppState.activePersonId && AppState.layoutMode === 'single') {
              AppState.singleCopies = p.copies;
              syncCopiesUI();
            } else {
              renderPeopleList();
              scheduleSheetRender();
            }
          }
        });

        // Card plus (add copies)
        card.querySelector('.btn-card-plus').addEventListener('click', (e) => {
          e.stopPropagation();
          p.copies = Math.min(MAX_COPIES, (p.copies || 0) + 1);
          if (p.id === AppState.activePersonId && AppState.layoutMode === 'single') {
            AppState.singleCopies = p.copies;
            syncCopiesUI();
          } else {
            renderPeopleList();
            scheduleSheetRender();
          }
        });

        // Duplicate
        card.querySelector('.btn-dup').addEventListener('click', (e) => {
          e.stopPropagation();
          duplicatePerson(p.id);
        });

        // Delete
        card.querySelector('.btn-del').addEventListener('click', (e) => {
          e.stopPropagation();
          deletePerson(p.id);
        });

        listEl.appendChild(card);
      });

      initLucide();
      renderMixedModeAllocationList();
    }

    function renderMixedModeAllocationList() {
      const container = document.getElementById('mixed-people-allocation-list');
      if (!container) return;

      container.innerHTML = '';
      let total = 0;

      AppState.people.forEach((p, idx) => {
        total += p.copies || 0;
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2 p-1.5 rounded bg-slate-50 border border-slate-200 text-xs';
        row.innerHTML = `
          <div class="flex items-center gap-2 truncate">
            <img src="${safeImgSrc(p.objectUrl)}" class="w-6 h-6 rounded object-cover shrink-0" />
            <span class="truncate font-medium text-slate-700">${escapeHtml(p.name)}</span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" class="btn-dec-mix w-5 h-5 rounded bg-white border border-slate-300 text-slate-600 font-bold flex items-center justify-center hover:bg-slate-100">-</button>
            <span class="w-6 text-center font-mono font-semibold text-slate-900">${p.copies || 0}</span>
            <button type="button" class="btn-inc-mix w-5 h-5 rounded bg-white border border-slate-300 text-slate-600 font-bold flex items-center justify-center hover:bg-slate-100">+</button>
          </div>
        `;

        row.querySelector('.btn-dec-mix').addEventListener('click', () => {
          p.copies = Math.max(0, (p.copies || 0) - 1);
          renderMixedModeAllocationList();
          scheduleSheetRender();
        });

        row.querySelector('.btn-inc-mix').addEventListener('click', () => {
          p.copies = Math.min(MAX_COPIES, (p.copies || 0) + 1);
          renderMixedModeAllocationList();
          scheduleSheetRender();
        });

        container.appendChild(row);
      });

      const totalLabel = document.getElementById('mixed-total-count');
      if (totalLabel) totalLabel.textContent = `Total: ${total}`;
    }

    function duplicatePerson(id) {
      if (AppState.people.length >= MAX_PEOPLE) {
        showToast('Maximum of ' + MAX_PEOPLE + ' people reached. Please delete an entry before adding more.', 'error');
        return;
      }
      const source = AppState.people.find(p => p.id === id);
      if (!source) return;

      const dup = {
        ...source,
        id: generateId(),
        name: `${source.name} (Copy)`,
        captionText: source.captionText || '',
        cropData: source.cropData ? { ...source.cropData } : null,
        canvasCache: null
      };

      AppState.people.push(dup);
      setActivePerson(dup.id);
      updateUI();
    }

    function deletePerson(id) {
      const idx = AppState.people.findIndex(p => p.id === id);
      if (idx === -1) return;

      const [removed] = AppState.people.splice(idx, 1);
      if (removed && removed.objectUrl) {
        URL.revokeObjectURL(removed.objectUrl);
      }

      if (AppState.activePersonId === id) {
        AppState.activePersonId = AppState.people.length > 0 ? AppState.people[0].id : null;
      }

      updateUI();
      if (AppState.activePersonId) {
        setActivePerson(AppState.activePersonId);
      } else {
        if (cropperInstance) cropperInstance.destroy();
        cropperInstance = null;
        document.getElementById('cropper-image').classList.add('opacity-0');
        document.getElementById('cropper-placeholder')?.classList.remove('hidden');
        document.getElementById('active-person-name').textContent = 'No Photo Selected';
        document.getElementById('active-person-meta').textContent = 'Open the Photos section to add one';
        document.getElementById('active-person-thumb').innerHTML = '<i data-lucide="user" class="w-5 h-5 text-slate-400"></i>';
        initLucide();
        scheduleSheetRender();
      }
    }

    function clearAllPhotos() {
      AppState.people.forEach(p => {
        if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
      });
      AppState.people = [];
      AppState.activePersonId = null;
      if (cropperInstance) {
        cropperInstance.destroy();
        cropperInstance = null;
      }
      document.getElementById('cropper-image').classList.add('opacity-0');
      document.getElementById('cropper-placeholder')?.classList.remove('hidden');
      document.getElementById('active-person-name').textContent = 'No Photo Selected';
      document.getElementById('active-person-meta').textContent = 'Open the Photos section to add one';
      document.getElementById('active-person-thumb').innerHTML = '<i data-lucide="user" class="w-5 h-5 text-slate-400"></i>';
      const inputPhotoText = document.getElementById('input-photo-text');
      if (inputPhotoText) inputPhotoText.value = '';
      updateCropCaptionOverlay();
      initLucide();
      updateUI();
      scheduleSheetRender();
    }

    function updateUI() {
      renderPeopleList();
      const hasPhotos = AppState.people.length > 0;
      document.getElementById('canvas-empty-overlay')?.classList.toggle('hidden', hasPhotos);
    }

    function escapeHtml(str) {
      return (str || '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
      }[m]));
    }

    // ========================================================
    // PHYSICAL LAYOUT ENGINE & MATHEMATICAL PACKING
    // ========================================================

    // Get Active Paper Dimensions in mm considering orientation
    function getActivePaperDimensions() {
      const base = PAPER_SIZES[AppState.paperSize] || PAPER_SIZES['A4'];
      if (AppState.orientation === 'landscape') {
        return { width: Math.max(base.width, base.height), height: Math.min(base.width, base.height), label: base.label };
      } else {
        return { width: Math.min(base.width, base.height), height: Math.max(base.width, base.height), label: base.label };
      }
    }

    // Calculate maximum single-sheet photo capacity based on dimensions & margins
    function calculateCurrentSheetCapacity() {
      const paper = getActivePaperDimensions();
      const person = getActivePerson();
      if (!person) return 0;

      const pDim = getPersonDimensions(person);
      const margin = AppState.sheetMarginMm;
      const marginTop = (AppState.sheetMarginTopMm !== undefined && AppState.sheetMarginTopMm !== null)
        ? AppState.sheetMarginTopMm
        : margin;
      const spacing = AppState.photoSpacingMm;

      const usableWidth = paper.width - (2 * margin);
      const usableHeight = paper.height - (marginTop + margin);

      if (usableWidth < pDim.width || usableHeight < pDim.height) return 0;

      const cols = Math.floor((usableWidth + spacing) / (pDim.width + spacing));
      const rows = Math.floor((usableHeight + spacing) / (pDim.height + spacing));

      return Math.max(0, cols * rows);
    }

    // Build the list of photos to place according to current mode
    function buildLayoutItemsList() {
      const items = [];
      if (AppState.layoutMode === 'single') {
        const person = getActivePerson();
        if (person) {
          const count = AppState.singleCopies || 1;
          for (let i = 0; i < count; i++) {
            items.push(person);
          }
        }
      } else {
        // Mixed mode
        AppState.people.forEach(p => {
          const count = p.copies || 0;
          for (let i = 0; i < count; i++) {
            items.push(p);
          }
        });
      }
      return items.length > MAX_TOTAL_ITEMS ? items.slice(0, MAX_TOTAL_ITEMS) : items;
    }

    // Calculate complete multi-sheet arrangement
    function calculateFullLayout() {
      const paper = getActivePaperDimensions();
      const margin = AppState.sheetMarginMm;
      const marginTop = (AppState.sheetMarginTopMm !== undefined && AppState.sheetMarginTopMm !== null)
        ? AppState.sheetMarginTopMm
        : margin;
      const spacing = AppState.photoSpacingMm;
      const items = buildLayoutItemsList();

      if (items.length === 0) {
        return {
          paper,
          sheets: [],
          totalPhotos: 0,
          photosPerSheet: 0,
          cols: 0,
          rows: 0
        };
      }

      // Representative photo dimension (standardized for grid)
      const refPerson = items[0];
      const pDim = getPersonDimensions(refPerson);

      const usableWidth = paper.width - (2 * margin);
      const usableHeight = paper.height - (marginTop + margin);

      const cols = Math.max(1, Math.floor((usableWidth + spacing) / (pDim.width + spacing)));
      const rows = Math.max(1, Math.floor((usableHeight + spacing) / (pDim.height + spacing)));
      const capacityPerSheet = cols * rows;

      // Centering offset calculations: Top margin sets row 1 position directly
      let startX = margin;
      let startY = marginTop;

      if (AppState.centerGrid) {
        const gridTotalWidth = (cols * pDim.width) + ((cols - 1) * spacing);
        startX = Math.max(margin, (paper.width - gridTotalWidth) / 2);
      }

      // Pack into sheets
      const sheets = [];
      let currentSheet = [];

      items.forEach((person, idx) => {
        const indexOnSheet = currentSheet.length;
        if (indexOnSheet >= capacityPerSheet) {
          sheets.push(currentSheet);
          currentSheet = [];
        }

        const slotIndex = currentSheet.length;
        const col = slotIndex % cols;
        const row = Math.floor(slotIndex / cols);

        const xMm = startX + (col * (pDim.width + spacing));
        const yMm = startY + (row * (pDim.height + spacing));

        currentSheet.push({
          person,
          xMm,
          yMm,
          widthMm: pDim.width,
          heightMm: pDim.height
        });
      });

      if (currentSheet.length > 0) {
        sheets.push(currentSheet);
      }

      return {
        paper,
        sheets,
        totalPhotos: items.length,
        photosPerSheet: capacityPerSheet,
        cols,
        rows
      };
    }

    function calculateTotalSheets() {
      const layout = calculateFullLayout();
      return Math.max(1, layout.sheets.length);
    }

    // Schedule Debounced Sheet Render
    function scheduleSheetRender() {
      if (previewDebounceTimer) cancelAnimationFrame(previewDebounceTimer);
      previewDebounceTimer = requestAnimationFrame(() => {
        renderCurrentSheetPreview();
      });
    }

    // ========================================================
    // PHOTO PROCESSING (High Resolution Canvas with Crop & Adjustments)
    // ========================================================

    async function getProcessedPhotoCanvas(person, targetDpi = PRINT_DPI) {
      if (person.canvasCache && person.canvasCache.dpi === targetDpi) {
        return person.canvasCache.canvas;
      }

      const dims = getPersonDimensions(person);
      const targetWidthPx = mmToPx(dims.width, targetDpi);
      const targetHeightPx = mmToPx(dims.height, targetDpi);

      const canvas = document.createElement('canvas');
      canvas.width = targetWidthPx;
      canvas.height = targetHeightPx;
      const ctx = canvas.getContext('2d');

      // 1. Background fill (White if enabled)
      if (person.whiteBackground) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetWidthPx, targetHeightPx);
      }

      // 2. Obtain Cropped Image Source
      const sourceImg = person.imageElement;
      if (!sourceImg || !sourceImg.complete) {
        return canvas;
      }

      // Check if we can extract directly from active cropperInstance
      let croppedSource = null;
      if (person.id === AppState.activePersonId && cropperInstance) {
        try {
          croppedSource = cropperInstance.getCroppedCanvas({
            width: targetWidthPx,
            height: targetHeightPx,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high'
          });
        } catch (e) {
          console.warn('Cropper getCroppedCanvas fallback', e);
        }
      }

      // Offscreen canvas for rotated / adjusted image drawing
      const offCanvas = document.createElement('canvas');
      offCanvas.width = targetWidthPx;
      offCanvas.height = targetHeightPx;
      const offCtx = offCanvas.getContext('2d');

      // Apply Image Adjustments (Brightness, Contrast)
      offCtx.filter = `brightness(${person.brightness}%) contrast(${person.contrast}%)`;

      if (croppedSource) {
        offCtx.drawImage(croppedSource, 0, 0, targetWidthPx, targetHeightPx);
      } else {
        // Fallback or inactive person calculation
        let cropX = 0;
        let cropY = 0;
        let cropW = sourceImg.naturalWidth;
        let cropH = sourceImg.naturalHeight;

        if (person.cropData) {
          cropX = Math.max(0, person.cropData.x || 0);
          cropY = Math.max(0, person.cropData.y || 0);
          cropW = Math.min(sourceImg.naturalWidth - cropX, person.cropData.width || sourceImg.naturalWidth);
          cropH = Math.min(sourceImg.naturalHeight - cropY, person.cropData.height || sourceImg.naturalHeight);
        } else {
          const targetAspect = dims.width / dims.height;
          const imgAspect = sourceImg.naturalWidth / sourceImg.naturalHeight;
          if (imgAspect > targetAspect) {
            cropH = sourceImg.naturalHeight;
            cropW = cropH * targetAspect;
            cropX = (sourceImg.naturalWidth - cropW) / 2;
            cropY = 0;
          } else {
            cropW = sourceImg.naturalWidth;
            cropH = cropW / targetAspect;
            cropX = 0;
            cropY = (sourceImg.naturalHeight - cropH) / 2;
          }
        }

        if (person.rotation !== 0) {
          offCtx.save();
          offCtx.translate(targetWidthPx / 2, targetHeightPx / 2);
          offCtx.rotate((person.rotation * Math.PI) / 180);
          offCtx.drawImage(
            sourceImg,
            cropX, cropY, cropW, cropH,
            -targetWidthPx / 2, -targetHeightPx / 2, targetWidthPx, targetHeightPx
          );
          offCtx.restore();
        } else {
          offCtx.drawImage(
            sourceImg,
            cropX, cropY, cropW, cropH,
            0, 0, targetWidthPx, targetHeightPx
          );
        }
      }

      // Draw onto target
      ctx.drawImage(offCanvas, 0, 0);

      // 2.5 Render Bottom White Bar & Name / Date Text (if specified)
      if (person.captionText && person.captionText.trim()) {
        const rawLines = person.captionText.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5);
        if (rawLines.length > 0) {
          // Calculate bar height proportionally (between 12% and 18% of target height)
          const barHeightRatio = rawLines.length === 1 ? 0.13 : Math.min(0.22, 0.10 + rawLines.length * 0.05);
          const barHeightPx = Math.round(targetHeightPx * barHeightRatio);
          const barY = targetHeightPx - barHeightPx;

          // Fill solid white bar
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, barY, targetWidthPx, barHeightPx);

          // Subtle hairline top separator
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = Math.max(1, Math.round(targetDpi / 300));
          ctx.beginPath();
          ctx.moveTo(0, barY);
          ctx.lineTo(targetWidthPx, barY);
          ctx.stroke();

          // Text formatting
          ctx.fillStyle = '#000000';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          // Base font size
          let baseFontSize = rawLines.length === 1 
            ? Math.round(barHeightPx * 0.48) 
            : Math.round(barHeightPx / (rawLines.length + 0.65));
          baseFontSize = Math.max(8, baseFontSize);

          // Measure and ensure text fits within width
          ctx.font = `bold ${baseFontSize}px "Plus Jakarta Sans", Arial, sans-serif`;
          const maxLineWidth = targetWidthPx - Math.round(16 * (targetDpi / 300));
          let finalFontSize = baseFontSize;
          for (const line of rawLines) {
            let lineW = ctx.measureText(line).width;
            while (lineW > maxLineWidth && finalFontSize > 6) {
              finalFontSize--;
              ctx.font = `bold ${finalFontSize}px "Plus Jakarta Sans", Arial, sans-serif`;
              lineW = ctx.measureText(line).width;
            }
          }

          ctx.font = `bold ${finalFontSize}px "Plus Jakarta Sans", Arial, sans-serif`;

          // Center lines vertically inside the white bar
          const lineStep = barHeightPx / (rawLines.length + 1);
          rawLines.forEach((line, idx) => {
            const lineY = barY + lineStep * (idx + 1);
            ctx.fillText(line, targetWidthPx / 2, lineY);
          });
        }
      }

      // 3. Render Inset Border (Measured in physical mm!)
      if (person.borderThicknessMm > 0) {
        const borderPx = (person.borderThicknessMm / MM_PER_INCH) * targetDpi;
        ctx.lineWidth = borderPx;
        ctx.strokeStyle = person.borderColor || '#000000';
        // Inset stroke so borders do not exceed outer dimension
        ctx.strokeRect(borderPx / 2, borderPx / 2, targetWidthPx - borderPx, targetHeightPx - borderPx);
      }

      person.canvasCache = { dpi: targetDpi, canvas };
      return canvas;
    }

    // ========================================================
    // SHEET CANVAS RENDERING (Unified for Preview and Export)
    // ========================================================

    async function renderSheet(sheetIndex, targetDpi, destinationCanvas) {
      const layout = calculateFullLayout();
      const paper = layout.paper;

      const sheetWidthPx = mmToPx(paper.width, targetDpi);
      const sheetHeightPx = mmToPx(paper.height, targetDpi);

      destinationCanvas.width = sheetWidthPx;
      destinationCanvas.height = sheetHeightPx;
      const ctx = destinationCanvas.getContext('2d');

      // 1. Crisp White Paper Background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sheetWidthPx, sheetHeightPx);

      const sheetPhotos = layout.sheets[sheetIndex] || [];

      // 2. Draw Cutting Guidelines first (under and around photos)
      if (AppState.showCutGuides && sheetPhotos.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#94a3b8'; // subtle slate-400
        ctx.lineWidth = Math.max(1, Math.round(targetDpi / 300));
        ctx.setLineDash([Math.round(4 * (targetDpi / 300)), Math.round(4 * (targetDpi / 300))]);

        sheetPhotos.forEach(item => {
          const x = mmToPx(item.xMm, targetDpi);
          const y = mmToPx(item.yMm, targetDpi);
          const w = mmToPx(item.widthMm, targetDpi);
          const h = mmToPx(item.heightMm, targetDpi);
          const ext = mmToPx(2.5, targetDpi); // extend cut mark 2.5mm beyond edges

          // Corner tick marks
          ctx.beginPath();
          // Top-left
          ctx.moveTo(x - ext, y); ctx.lineTo(x, y);
          ctx.moveTo(x, y - ext); ctx.lineTo(x, y);
          // Top-right
          ctx.moveTo(x + w, y); ctx.lineTo(x + w + ext, y);
          ctx.moveTo(x + w, y - ext); ctx.lineTo(x + w, y);
          // Bottom-left
          ctx.moveTo(x - ext, y + h); ctx.lineTo(x, y + h);
          ctx.moveTo(x, y + h); ctx.lineTo(x, y + h + ext);
          // Bottom-right
          ctx.moveTo(x + w, y + h); ctx.lineTo(x + w + ext, y + h);
          ctx.moveTo(x + w, y + h); ctx.lineTo(x + w, y + h + ext);
          ctx.stroke();
        });
        ctx.restore();
      }

      // 3. Draw Photos
      for (const item of sheetPhotos) {
        const photoCanvas = await getProcessedPhotoCanvas(item.person, targetDpi);
        const x = mmToPx(item.xMm, targetDpi);
        const y = mmToPx(item.yMm, targetDpi);
        const w = mmToPx(item.widthMm, targetDpi);
        const h = mmToPx(item.heightMm, targetDpi);

        ctx.drawImage(photoCanvas, x, y, w, h);
      }

      return destinationCanvas;
    }

    // Live Preview Rendering (Screen resolution for 60fps performance)
    async function renderCurrentSheetPreview() {
      const layout = calculateFullLayout();
      const previewCanvas = document.getElementById('sheet-preview-canvas');
      if (!previewCanvas) return;

      // Update Spec Badges & Metrics
      const paper = layout.paper;
      document.getElementById('display-paper-label').textContent = `${paper.label} (${paper.width} × ${paper.height} mm)`;
      
      const person = getActivePerson();
      const pDim = getPersonDimensions(person);
      document.getElementById('display-photo-dim-label').textContent = `${pDim.width} × ${pDim.height} mm (${(pDim.width/10).toFixed(1)} × ${(pDim.height/10).toFixed(1)} cm)`;

      const targetPxW = mmToPx(paper.width, PRINT_DPI);
      const targetPxH = mmToPx(paper.height, PRINT_DPI);
      document.getElementById('display-resolution-label').textContent = `${targetPxW} × ${targetPxH} px @ ${PRINT_DPI} DPI`;

      // Update Capacity Labels
      document.getElementById('capacity-photos-fit').textContent = `${layout.photosPerSheet} photos / sheet`;
      document.getElementById('capacity-grid-cols-rows').textContent = `${layout.cols} cols × ${layout.rows} rows`;

      const totalSheets = Math.max(1, layout.sheets.length);
      const hasOverflow = layout.totalPhotos > layout.photosPerSheet;
      document.getElementById('overflow-warning')?.classList.toggle('hidden', !hasOverflow);
      document.getElementById('total-sheets-count').textContent = totalSheets.toString();

      // Pagination Indicator
      const pageNav = document.getElementById('page-nav-controls');
      if (totalSheets > 1) {
        pageNav.classList.remove('hidden');
        pageNav.classList.add('flex');
        document.getElementById('page-indicator').textContent = `${AppState.activeSheetIndex + 1} / ${totalSheets}`;
        document.getElementById('btn-prev-page').disabled = AppState.activeSheetIndex === 0;
        document.getElementById('btn-next-page').disabled = AppState.activeSheetIndex >= totalSheets - 1;
      } else {
        pageNav.classList.add('hidden');
        pageNav.classList.remove('flex');
        AppState.activeSheetIndex = 0;
      }

      // Render Sheet Canvas at display resolution (approx 100 DPI or scaled)
      const previewDpi = 100;
      await renderSheet(AppState.activeSheetIndex, previewDpi, previewCanvas);

      applyCanvasTransform();
    }

    // Apply Zoom & Pan Transform to the sheet canvas wrapper
    function applyCanvasTransform() {
      const wrapper = document.getElementById('canvas-wrapper');
      const viewport = document.getElementById('preview-viewport');
      const canvas = document.getElementById('sheet-preview-canvas');
      if (!wrapper || !viewport || !canvas || canvas.width === 0) return;

      if (AppState.zoomLevel === 'fit') {
        const vW = viewport.clientWidth - 48;
        const vH = viewport.clientHeight - 48;
        const scaleW = vW / canvas.width;
        const scaleH = vH / canvas.height;
        AppState.zoomScale = Math.min(scaleW, scaleH, 1.4);
        document.getElementById('zoom-level-text').textContent = 'Fit';
      } else {
        document.getElementById('zoom-level-text').textContent = Math.round(AppState.zoomScale * 100) + '%';
      }

      wrapper.style.transform = `translate(${AppState.panOffsetX}px, ${AppState.panOffsetY}px) scale(${AppState.zoomScale})`;
    }

    function changeZoom(delta) {
      if (AppState.zoomLevel === 'fit') {
        AppState.zoomLevel = AppState.zoomScale;
      }
      AppState.zoomLevel = Math.min(8.0, Math.max(0.1, AppState.zoomLevel + delta * Math.max(1, AppState.zoomLevel)));
      AppState.zoomScale = AppState.zoomLevel;
      applyCanvasTransform();
    }

    // ========================================================
    // EXPORT WORKFLOWS (PDF, JPEG, PNG, Single Photo)
    // ========================================================

    function showSpinner(msg) {
      const sp = document.getElementById('rendering-spinner');
      const label = document.getElementById('spinner-msg');
      if (label) label.textContent = msg;
      if (sp) sp.classList.remove('hidden');
    }

    function hideSpinner() {
      const sp = document.getElementById('rendering-spinner');
      if (sp) sp.classList.add('hidden');
    }

    // Real PDF Export using jsPDF at exact millimeter units
    async function exportPDF() {
      if (AppState.people.length === 0) {
        showToast('Please upload or select at least one photo before exporting.', 'error');
        return;
      }

      if (!window.jspdf || !window.jspdf.jsPDF) {
        showToast('PDF Generation Library (jsPDF) is loading or unavailable. Please check your connection.', 'error');
        return;
      }

      showSpinner('Generating 300 DPI Print PDF...');

      try {
        const { jsPDF } = window.jspdf;
        const layout = calculateFullLayout();
        const paper = layout.paper;
        const totalSheets = Math.max(1, layout.sheets.length);

        const pdfOrientation = AppState.orientation === 'landscape' ? 'landscape' : 'portrait';

        const doc = new jsPDF({
          orientation: pdfOrientation,
          unit: 'mm',
          format: AppState.paperSize === 'A4' ? 'a4' : [paper.width, paper.height],
          compress: true
        });

        // High resolution offscreen canvas for 300 DPI rendering
        const hiResCanvas = document.createElement('canvas');

        for (let i = 0; i < totalSheets; i++) {
          if (i > 0) doc.addPage([paper.width, paper.height], pdfOrientation);

          showSpinner(`Rendering 300 DPI Sheet ${i + 1} of ${totalSheets}...`);
          await renderSheet(i, PRINT_DPI, hiResCanvas);

          const imgData = hiResCanvas.toDataURL('image/jpeg', 0.95);
          doc.addImage(imgData, 'JPEG', 0, 0, paper.width, paper.height, undefined, 'FAST');
        }

        const person = getActivePerson();
        const pDim = getPersonDimensions(person);
        const fileName = `passport-photo-hub-${paper.label}-${pDim.width}x${pDim.height}mm.pdf`;

        doc.save(fileName);
        showToast('PDF downloaded successfully!', 'success');
      } catch (err) {
        console.error('PDF Export Error:', err);
        showToast('Failed to generate PDF: ' + err.message, 'error');
      } finally {
        hideSpinner();
      }
    }

    // High Resolution JPEG or PNG Export
    async function exportImage(format = 'jpeg') {
      if (AppState.people.length === 0) {
        showToast('Please upload or select at least one photo before exporting.', 'error');
        return;
      }

      showSpinner(`Rendering 300 DPI ${format.toUpperCase()}...`);

      try {
        const layout = calculateFullLayout();
        const paper = layout.paper;
        const hiResCanvas = document.createElement('canvas');

        // Render current active sheet at 300 DPI
        await renderSheet(AppState.activeSheetIndex, PRINT_DPI, hiResCanvas);

        const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
        const quality = format === 'png' ? undefined : 0.95;

        hiResCanvas.toBlob((blob) => {
          if (!blob) {
            showToast('Failed to encode image data.', 'error');
            hideSpinner();
            return;
          }

          const person = getActivePerson();
          const pDim = getPersonDimensions(person);
          const fileName = `passport-photo-hub-${paper.label}-${pDim.width}x${pDim.height}mm-sheet${AppState.activeSheetIndex + 1}.${format}`;

          downloadBlob(blob, fileName);
          hideSpinner();
          showToast(`${format.toUpperCase()} sheet downloaded!`, 'success');
        }, mimeType, quality);

      } catch (err) {
        console.error('Image Export Error:', err);
        showToast('Failed to export image: ' + err.message, 'error');
        hideSpinner();
      }
    }

    // Export Single Photo (300 DPI for Online Applications)
    async function exportSinglePhoto() {
      const person = getActivePerson();
      if (!person) {
        showToast('Please select a photo entry first.', 'error');
        return;
      }

      showSpinner('Generating 300 DPI Single Photo...');

      try {
        const photoCanvas = await getProcessedPhotoCanvas(person, PRINT_DPI);
        const dims = getPersonDimensions(person);

        photoCanvas.toBlob((blob) => {
          if (!blob) {
            showToast('Failed to encode photo.', 'error');
            hideSpinner();
            return;
          }

          const safeName = person.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
          const fileName = `${safeName}-${dims.width}x${dims.height}mm-300dpi.jpg`;

          downloadBlob(blob, fileName);
          hideSpinner();
          showToast('Single 300 DPI photo exported!', 'success');
        }, 'image/jpeg', 0.95);
      } catch (err) {
        console.error('Single photo export error:', err);
        showToast('Failed to export single photo: ' + err.message, 'error');
        hideSpinner();
      }
    }

    function downloadBlob(blob, fileName) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
