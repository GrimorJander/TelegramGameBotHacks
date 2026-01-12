// ============================================
        // CONSTANTES Y CONFIGURACIÓN
        // ============================================
        const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const CHARACTERISTIC_UUID_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const CHARACTERISTIC_UUID_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
        const APP_VERSION = '1.0.0';

        // ============================================
        // ESTADO DE LA APLICACIÓN
        // ============================================
        let device = null, server = null, rxCharacteristic = null, txCharacteristic = null;
        let isConnected = false;
        let currentMode = 'SOLO';
        let isAutoMode = false;
        let isRunning = false;
        let multiResults = [];
        let selectedRunners = 0;
        let visualTimerInterval = null;
        let visualTimerStart = null;
        let splitWaitingForStart = false;
        let isWaitingForAutoStart = false;

        // Preferencias
        let soundEnabled = true;
        let vibrationEnabled = true;
        let showTimestamp = false;
        let audioContext = null;
        let logHistory = [];

        // Control de debounce
        const DEBOUNCE_DELAY = 800;
        let commandLocks = {};

        // PWA
        let deferredPrompt = null;
        let swRegistration = null;

        // ============================================
        // VERIFICACIÓN DE COMPATIBILIDAD
        // ============================================
        const browserSupport = {
            bluetooth: 'bluetooth' in navigator,
            serviceWorker: 'serviceWorker' in navigator,
            notifications: 'Notification' in window,
            share: 'share' in navigator,
            vibration: 'vibrate' in navigator,
            clipboard: 'clipboard' in navigator
        };

        function checkCompatibility() {
            if (!browserSupport.bluetooth) {
                const banner = document.getElementById('compatibilityBanner');
                banner.classList.add('show');

                const indicator = document.getElementById('statusIndicator');
                const statusText = document.getElementById('statusText');
                const btnConnect = document.getElementById('btnConnect');

                indicator.classList.add('unsupported');
                statusText.textContent = 'Bluetooth no soportado';
                btnConnect.disabled = true;
                btnConnect.textContent = 'No disponible';

                addLog('⚠️ Web Bluetooth no soportado en este navegador', 'error');
                addLog('ℹ️ Usa Chrome, Edge o Samsung Internet en Android', 'info');
                addLog('ℹ️ En iOS, Web Bluetooth no está disponible', 'info');
            }
        }

        function hideCompatibilityBanner() {
            document.getElementById('compatibilityBanner').classList.remove('show');
        }

        // ============================================
        // PWA - SERVICE WORKER
        // ============================================
        async function initServiceWorker() {
            if (!browserSupport.serviceWorker) {
                console.log('Service Worker no soportado');
                return;
            }

            try {
                swRegistration = await navigator.serviceWorker.register('/sw.js');
                console.log('Service Worker registrado:', swRegistration);

                // Verificar actualizaciones
                swRegistration.addEventListener('updatefound', () => {
                    const newWorker = swRegistration.installing;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            // Nueva versión disponible
                            document.getElementById('updateBanner').classList.add('show');
                        }
                    });
                });

                // Escuchar mensajes del SW
                navigator.serviceWorker.addEventListener('message', (event) => {
                    console.log('Mensaje del SW:', event.data);
                });

            } catch (error) {
                console.error('Error registrando Service Worker:', error);
            }
        }

        function updateApp() {
            if (swRegistration && swRegistration.waiting) {
                swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
            window.location.reload();
        }

        // ============================================
        // PWA - INSTALACIÓN
        // ============================================
        function initInstallPrompt() {
            window.addEventListener('beforeinstallprompt', (e) => {
                e.preventDefault();
                deferredPrompt = e;

                // Mostrar banner de instalación si no está instalada
                if (!isAppInstalled()) {
                    setTimeout(() => {
                        document.getElementById('installBanner').classList.add('show');
                    }, 3000);
                }
            });

            window.addEventListener('appinstalled', () => {
                console.log('App instalada');
                deferredPrompt = null;
                hideInstallBanner();
                showToast('✅ App instalada correctamente', 'success');
            });

            document.getElementById('installBtn').addEventListener('click', installApp);
        }

        function isAppInstalled() {
            return window.matchMedia('(display-mode: standalone)').matches ||
                   window.navigator.standalone === true;
        }

        async function installApp() {
            if (!deferredPrompt) {
                // Mostrar instrucciones manuales para iOS
                if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
                    showToast('📱 Pulsa el botón compartir y "Añadir a pantalla de inicio"', 'info');
                }
                return;
            }

            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log('Resultado instalación:', outcome);

            deferredPrompt = null;
            hideInstallBanner();
        }

        function hideInstallBanner() {
            document.getElementById('installBanner').classList.remove('show');
            localStorage.setItem('installBannerDismissed', 'true');
        }

        // ============================================
        // DETECCIÓN DE CONEXIÓN ONLINE/OFFLINE
        // ============================================
        function initNetworkStatus() {
            function updateOnlineStatus() {
                const indicator = document.getElementById('offlineIndicator');
                if (navigator.onLine) {
                    indicator.classList.remove('show');
                } else {
                    indicator.classList.add('show');
                }
            }

            window.addEventListener('online', updateOnlineStatus);
            window.addEventListener('offline', updateOnlineStatus);
            updateOnlineStatus();
        }

        // ============================================
        // SISTEMA DE BLOQUEO DE COMANDOS
        // ============================================
        function isCommandLocked(cmd) {
            const now = Date.now();
            if (commandLocks[cmd] && (now - commandLocks[cmd]) < DEBOUNCE_DELAY) {
                console.log(`Comando '${cmd}' bloqueado (debounce)`);
                return true;
            }
            return false;
        }

        function lockCommand(cmd) {
            commandLocks[cmd] = Date.now();
        }

        // ============================================
        // ELEMENTOS DEL DOM
        // ============================================
        const timerDisplay = document.getElementById('timerDisplay');
        const modeBadge = document.getElementById('modeBadge');
        const btnConnect = document.getElementById('btnConnect');
        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');
        const btnReset = document.getElementById('btnReset');
        const btnSolo = document.getElementById('btnSolo');
        const btnMulti = document.getElementById('btnMulti');
        const btnSplit = document.getElementById('btnSplit');
        const btnAutoMode = document.getElementById('btnAutoMode');
        const btnBattery = document.getElementById('btnBattery');
        const btnSendCommand = document.getElementById('btnSendCommand');
        const btnShare = document.getElementById('btnShare');
        const btnClear = document.getElementById('btnClear');
        const commandInput = document.getElementById('commandInput');
        const bestTime = document.getElementById('bestTime');
        const logConsole = document.getElementById('logConsole');
        const multiInputCard = document.getElementById('multiInputCard');
        const runnersSelector = document.getElementById('runnersSelector');
        const resultsCard = document.getElementById('resultsCard');
        const resultsList = document.getElementById('resultsList');

        // ============================================
        // INICIALIZACIÓN
        // ============================================
        document.addEventListener('DOMContentLoaded', () => {
            // Inicializar PWA
            initServiceWorker();
            initInstallPrompt();
            initNetworkStatus();

            // Verificar compatibilidad
            checkCompatibility();

            // Inicializar UI
            initRunnersSelector();
            loadPreferences();
            renderTime('00.00');
            updateModeDisplay();
            setupEventListeners();

            // Log de inicio
            addLog(`🚀 CAIM v${APP_VERSION} iniciado`, 'info');

            if (isAppInstalled()) {
                addLog('📱 Ejecutando como PWA instalada', 'info');
            }
        });

        function setupEventListeners() {
            // Conexión
            btnConnect.addEventListener('click', safeClick(toggleConnection));

            // Controles principales
            setupButtonEvent(btnStart, () => sendCommandSafe('start'));
            setupButtonEvent(btnStop, () => sendCommandSafe('stop'));
            setupButtonEvent(btnReset, () => sendCommandSafe('reset'));

            // Modos
            setupButtonEvent(btnSolo, () => sendCommandSafe('solo'));
            setupButtonEvent(btnMulti, () => sendCommandSafe('multi'));
            setupButtonEvent(btnSplit, () => sendCommandSafe('split'));
            setupButtonEvent(btnAutoMode, () => sendCommandSafe('auto'));

            // Batería
            setupButtonEvent(btnBattery, () => sendCommandSafe('bat'));

            // Log
            btnShare.addEventListener('click', safeClick(shareLog));
            btnClear.addEventListener('click', safeClick(clearLog));
            btnSendCommand.addEventListener('click', safeClick(sendCustomCommand));
            commandInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') sendCustomCommand();
            });

            // Preferencias
            document.getElementById('chkSound').addEventListener('change', toggleSound);
            document.getElementById('chkVibration').addEventListener('change', toggleVibration);
            document.getElementById('chkTimestamp').addEventListener('change', toggleTimestamp);
        }

        function setupButtonEvent(btn, handler) {
            let lastTrigger = 0;

            const triggerHandler = (e) => {
                e.preventDefault();
                e.stopPropagation();

                const now = Date.now();
                if (now - lastTrigger < DEBOUNCE_DELAY) {
                    return;
                }
                lastTrigger = now;

                handler();
            };

            btn.addEventListener('click', triggerHandler);
        }

        function safeClick(handler) {
            let lastClick = 0;
            return (e) => {
                const now = Date.now();
                if (now - lastClick < 300) return;
                lastClick = now;
                handler(e);
            };
        }

        // ============================================
        // NORMALIZAR Y RENDER TIME
        // ============================================
        function normalizeTimeFormat(timeStr) {
            return timeStr.replace(/^0(\d:)/, '$1');
        }

        function renderTime(timeStr) {
            const normalized = normalizeTimeFormat(timeStr);

            let html = '';
            for (let char of normalized) {
                if (char === ':' || char === '.') {
                    html += `<span class="sep">${char}</span>`;
                } else {
                    html += `<span class="digit">${char}</span>`;
                }
            }
            timerDisplay.innerHTML = html;
        }

        function formatTime(ms) {
            const totalSeconds = ms / 1000;
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = Math.floor(totalSeconds % 60);
            const centiseconds = Math.floor((ms % 1000) / 10);

            if (minutes > 0) {
                return `${minutes}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
            }
            return `${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
        }

        function startVisualTimer() {
            if (visualTimerInterval) return;
            visualTimerStart = Date.now();
            timerDisplay.classList.remove('waiting');
            timerDisplay.classList.add('running');
            isRunning = true;
            isWaitingForAutoStart = false;

            visualTimerInterval = setInterval(() => {
                renderTime(formatTime(Date.now() - visualTimerStart));
            }, 10);
        }

        function stopVisualTimer() {
            if (visualTimerInterval) {
                clearInterval(visualTimerInterval);
                visualTimerInterval = null;
            }
            timerDisplay.classList.remove('running');
            timerDisplay.classList.remove('waiting');
            isRunning = false;
            isWaitingForAutoStart = false;
        }

        function resetVisualTimer() {
            stopVisualTimer();
            renderTime('00.00');
            visualTimerStart = null;
            splitWaitingForStart = false;
            isWaitingForAutoStart = false;
        }

        function setAutoWaitingState() {
            isWaitingForAutoStart = true;
            timerDisplay.classList.add('waiting');
            timerDisplay.classList.remove('running');
            renderTime('00.00');
        }

        // ============================================
        // AUDIO
        // ============================================
        function initAudioContext() {
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
        }

        function playBeep(f = 800, d = 150, v = 0.5) {
            if (!soundEnabled) return;
            try {
                initAudioContext();
                const o = audioContext.createOscillator();
                const g = audioContext.createGain();
                o.connect(g);
                g.connect(audioContext.destination);
                o.frequency.value = f;
                o.type = 'sine';
                g.gain.setValueAtTime(v, audioContext.currentTime);
                g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + d / 1000);
                o.start();
                o.stop(audioContext.currentTime + d / 1000);
            } catch (e) {}
        }

        const sounds = {
            connect: () => { playBeep(600, 100); setTimeout(() => playBeep(800, 100), 120); setTimeout(() => playBeep(1000, 150), 240); },
            disconnect: () => { playBeep(800, 100); setTimeout(() => playBeep(600, 100), 120); setTimeout(() => playBeep(400, 200), 240); },
            start: () => playBeep(1200, 100),
            stop: () => { playBeep(1000, 80); setTimeout(() => playBeep(1000, 80), 100); },
            newPB: () => { playBeep(800, 100); setTimeout(() => playBeep(1000, 100), 120); setTimeout(() => playBeep(1200, 100), 240); setTimeout(() => playBeep(1600, 300), 360); },
            mode: () => playBeep(900, 150),
            error: () => playBeep(300, 300, 0.4),
            click: () => playBeep(1000, 50, 0.2),
            result: () => playBeep(880, 100),
            send: () => playBeep(1100, 80, 0.3),
            go: () => { playBeep(1000, 100); setTimeout(() => playBeep(1400, 150), 120); }
        };

        function vibrate(p) {
            if (!vibrationEnabled || !browserSupport.vibration) return;
            try {
                navigator.vibrate(p);
            } catch (e) {}
        }

        const vibrations = {
            connect: [100, 50, 100, 50, 150],
            disconnect: [200, 100, 200],
            start: 100,
            stop: [100, 50, 100],
            newPB: [100, 50, 100, 50, 100, 100, 200],
            mode: 100,
            error: [200, 100, 200, 100, 200],
            click: 30,
            result: [50, 30, 50],
            send: 50,
            go: [150, 50, 150]
        };

        function feedback(t) {
            if (sounds[t]) sounds[t]();
            if (vibrations[t]) vibrate(vibrations[t]);
        }

        function toggleSound() {
            soundEnabled = document.getElementById('chkSound').checked;
            localStorage.setItem('soundEnabled', soundEnabled);
            if (soundEnabled) {
                initAudioContext();
                playBeep(800, 80);
            }
        }

        function toggleVibration() {
            vibrationEnabled = document.getElementById('chkVibration').checked;
            localStorage.setItem('vibrationEnabled', vibrationEnabled);
            if (vibrationEnabled) vibrate(100);
        }

        function toggleTimestamp() {
            showTimestamp = document.getElementById('chkTimestamp').checked;
            localStorage.setItem('showTimestamp', showTimestamp);
            document.querySelectorAll('.log-entry .time').forEach(el =>
                el.classList.toggle('show', showTimestamp)
            );
        }

        function loadPreferences() {
            const s = localStorage.getItem('soundEnabled');
            const v = localStorage.getItem('vibrationEnabled');
            const t = localStorage.getItem('showTimestamp');
            if (s !== null) soundEnabled = s === 'true';
            if (v !== null) vibrationEnabled = v === 'true';
            if (t !== null) showTimestamp = t === 'true';
            document.getElementById('chkSound').checked = soundEnabled;
            document.getElementById('chkVibration').checked = vibrationEnabled;
            document.getElementById('chkTimestamp').checked = showTimestamp;
        }

        // ============================================
        // SELECTOR DE CORREDORES
        // ============================================
        function initRunnersSelector() {
            runnersSelector.innerHTML = '';
            for (let i = 2; i <= 10; i++) {
                const btn = document.createElement('button');
                btn.className = 'runner-btn';
                btn.textContent = i;
                btn.addEventListener('click', () => selectRunners(i));
                runnersSelector.appendChild(btn);
            }
        }

        function selectRunners(n) {
            feedback('click');
            selectedRunners = n;
            document.querySelectorAll('.runner-btn').forEach(b =>
                b.classList.toggle('selected', parseInt(b.textContent) === n)
            );
            sendCommandSafe(n.toString());
            updateModeDisplay();
        }

        // ============================================
        // CONEXIÓN BLUETOOTH
        // ============================================
        async function toggleConnection() {
            feedback('click');
            initAudioContext();
            if (isConnected) {
                disconnect();
            } else {
                await connect();
            }
        }

        async function connect() {
            if (!browserSupport.bluetooth) {
                showToast('❌ Bluetooth no soportado', 'error');
                return;
            }

            try {
                addLog('Buscando CAIM...', 'info');

                device = await navigator.bluetooth.requestDevice({
                    filters: [{ name: 'CAIM' }],
                    optionalServices: [SERVICE_UUID]
                });

                addLog('Conectando...', 'info');
                device.addEventListener('gattserverdisconnected', onDisconnected);
                server = await device.gatt.connect();
                const service = await server.getPrimaryService(SERVICE_UUID);
                rxCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_RX);
                txCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_TX);
                await txCharacteristic.startNotifications();
                txCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);

                isConnected = true;
                updateConnectionUI(true);
                addLog('✅ Conectado', 'success');
                showToast('Conectado', 'success');
                feedback('connect');
                setButtonsEnabled(true);
                resetToDefaultState();
            } catch (e) {
                addLog('❌ ' + e.message, 'error');
                showToast('Error de conexión', 'error');
                feedback('error');
            }
        }

        function resetToDefaultState() {
            currentMode = 'SOLO';
            isAutoMode = false;
            multiInputCard.classList.remove('show');
            resultsCard.classList.remove('show');
            multiResults = [];
            selectedRunners = 0;
            splitWaitingForStart = false;
            isWaitingForAutoStart = false;
            document.querySelectorAll('.runner-btn').forEach(b => b.classList.remove('selected'));
            resetVisualTimer();
            updateModeDisplay();
        }

        function disconnect() {
            if (device && device.gatt.connected) {
                device.gatt.disconnect();
            }
            onDisconnected();
        }

        function onDisconnected() {
            isConnected = false;
            device = null;
            server = null;
            rxCharacteristic = null;
            txCharacteristic = null;
            updateConnectionUI(false);
            setButtonsEnabled(false);
            addLog('🔌 Desconectado', 'info');
            showToast('Desconectado', 'error');
            feedback('disconnect');
            resetToDefaultState();
        }

        function updateConnectionUI(connected) {
            const ind = document.getElementById('statusIndicator');
            const txt = document.getElementById('statusText');
            if (connected) {
                ind.classList.add('connected');
                ind.classList.remove('unsupported');
                txt.textContent = 'Conectado';
                btnConnect.textContent = 'Desconectar';
                btnConnect.classList.add('disconnect');
            } else {
                ind.classList.remove('connected');
                txt.textContent = 'Desconectado';
                btnConnect.textContent = 'Conectar';
                btnConnect.classList.remove('disconnect');
            }
        }

        function setButtonsEnabled(enabled) {
            btnStart.disabled = !enabled;
            btnStop.disabled = !enabled;
            btnReset.disabled = !enabled;
            btnSolo.disabled = !enabled;
            btnMulti.disabled = !enabled;
            btnSplit.disabled = !enabled;
            btnAutoMode.disabled = !enabled;
            btnBattery.disabled = !enabled;
            commandInput.disabled = !enabled;
            btnSendCommand.disabled = !enabled;
        }

        // ============================================
        // ENVÍO DE COMANDOS
        // ============================================
        async function sendCommandSafe(cmd) {
            if (isCommandLocked(cmd)) {
                return;
            }

            lockCommand(cmd);

            if (!rxCharacteristic) {
                feedback('error');
                return;
            }

            try {
                await rxCharacteristic.writeValue(new TextEncoder().encode(cmd));
                handleLocalCommandAction(cmd);
            } catch (e) {
                addLog('❌ ' + e.message, 'error');
                feedback('error');
            }
        }

        function handleLocalCommandAction(cmd) {
            switch (cmd) {
                case 'start':
                    if (currentMode === 'SOLO' && isAutoMode) {
                        setAutoWaitingState();
                        feedback('click');
                        showToast('Esperando AUTO GO...', 'info');
                    } else if (currentMode === 'SOLO') {
                        startVisualTimer();
                        feedback('start');
                    } else if (currentMode === 'MULTI') {
                        startVisualTimer();
                        feedback('start');
                    } else if (currentMode === 'SPLIT') {
                        splitWaitingForStart = true;
                        renderTime('00.00');
                        feedback('click');
                    }
                    break;

                case 'stop':
                    feedback('stop');
                    break;

                case 'reset':
                    resetVisualTimer();
                    multiResults = [];
                    updateResultsDisplay();
                    feedback('click');
                    break;

                case 'solo':
                case 'multi':
                case 'split':
                case 'auto':
                    addLog(`📤 ${cmd}`, 'sent');
                    feedback('mode');
                    break;

                case 'bat':
                    feedback('click');
                    break;

                default:
                    feedback('click');
            }
        }

        async function sendCustomCommand() {
            const cmd = commandInput.value.trim();
            if (!cmd) return;
            if (!rxCharacteristic) {
                addLog('❌ Sin conexión', 'error');
                feedback('error');
                return;
            }
            try {
                await rxCharacteristic.writeValue(new TextEncoder().encode(cmd));
                addLog('📤 ' + cmd, 'sent');
                feedback('send');
                commandInput.value = '';
            } catch (e) {
                addLog('❌ ' + e.message, 'error');
                feedback('error');
            }
        }

        // ============================================
        // COMPARTIR LOG
        // ============================================
        async function shareLog() {
            const txt = generateLogText();
            if (browserSupport.share) {
                try {
                    await navigator.share({ title: 'CAIM', text: txt });
                    feedback('click');
                } catch (e) {
                    if (e.name !== 'AbortError') fallbackShare(txt);
                }
            } else {
                fallbackShare(txt);
            }
        }

        function generateLogText() {
            const d = new Date().toLocaleDateString('es-ES');
            const t = new Date().toLocaleTimeString('es-ES');
            let modeText = currentMode;
            if (isAutoMode) modeText += ' + AUTO';
            if (selectedRunners > 0) modeText += ` - ${selectedRunners} corredores`;

            let txt = `🏃 CAIM v${APP_VERSION}\n📅 ${d} ${t}\n${'─'.repeat(30)}\n\n`;
            logHistory.forEach(e => {
                txt += showTimestamp ? `${e.time} ${e.message}\n` : `${e.message}\n`;
            });
            txt += `\n${'─'.repeat(30)}\nModo: ${modeText}\n`;
            return txt;
        }

        function fallbackShare(txt) {
            if (browserSupport.clipboard) {
                navigator.clipboard.writeText(txt)
                    .then(() => { showToast('📋 Copiado al portapapeles', 'success'); feedback('click'); })
                    .catch(() => manualCopy(txt));
            } else {
                manualCopy(txt);
            }
        }

        function manualCopy(txt) {
            const ta = document.createElement('textarea');
            ta.value = txt;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                showToast('📋 Copiado', 'success');
            } catch (e) {
                showToast('Error al copiar', 'error');
            }
            document.body.removeChild(ta);
        }

        // ============================================
        // MANEJO DE NOTIFICACIONES BLE
        // ============================================
        function handleNotification(event) {
            const msg = new TextDecoder().decode(event.target.value).trim();
            if (!msg) return;
            const up = msg.toUpperCase();

            console.log('BLE RX:', msg);

            // Mensajes de espera AUTO (antes de GO)
            if (up.includes('AUTO') && (up.includes('PENDIENTE') || up.includes('PENDING') || up.includes('WAITING'))) {
                handleAutoWaitingMessage(msg);
                return;
            }

            // Señal "AUTO GO" específicamente
            if (up === 'AUTO GO' || up.includes('AUTO GO')) {
                handleAutoGoSignal(msg);
                return;
            }

            // Señal "GO" simple
            if (up === 'GO') {
                handleGoSignal(msg);
                return;
            }

            // RESET desde el dispositivo
            if (up === 'RESET' || up.includes('RESET')) {
                handleRemoteReset(msg);
                return;
            }

            // Parsear otros mensajes
            if (msg.includes('Crono =') && msg.includes('Laser =')) {
                parseBatteryMessage(msg);
            } else if (msg.includes('PB:')) {
                parseTimeResult(msg);
            } else if (up.includes('AUTO') && (up.includes('ON') || up.includes('OFF'))) {
                parseAutoMessage(msg);
            } else if (up.includes('MODO') || up.includes('MODE') || up === 'SOLO' || up === 'MULTI' || up === 'SPLIT') {
                parseModeMessage(msg);
            } else if (up.includes('RUNNERS') || up.includes('RUNNER') || up.includes('CORREDORES')) {
                addLog(msg, 'info');
                multiInputCard.classList.remove('show');
                feedback('mode');
            } else if (msg.match(/^\d+:\s*[\d:.]+/)) {
                parseMultiResult(msg);
            } else if (msg.match(/^[\d:.]+/)) {
                parseSplitOrSimpleTime(msg);
            } else if (msg !== '----------') {
                addLog(msg, 'result');
            }
        }

        function handleAutoWaitingMessage(msg) {
            addLog(`⏳ ${msg}`, 'info');
            setAutoWaitingState();
            feedback('click');
            showToast('Esperando AUTO GO...', 'info');
        }

        function handleAutoGoSignal(msg) {
            addLog(`🚀 ${msg}`, 'result');

            if (!isRunning) {
                startVisualTimer();
                feedback('go');
                showToast('¡GO!', 'success');
            }

            isWaitingForAutoStart = false;
        }

        function handleGoSignal(msg) {
            if (currentMode === 'SOLO' && isAutoMode) {
                addLog(`ℹ️ ${msg} (ignorado en modo AUTO)`, 'info');
                return;
            }

            addLog(`🚀 ${msg}`, 'result');

            if (!isRunning) {
                if (currentMode === 'SPLIT') {
                    splitWaitingForStart = false;
                }
                startVisualTimer();
                feedback('go');
                showToast('¡GO!', 'success');
            }
        }

        function handleRemoteReset(msg) {
            addLog(`🔄 ${msg}`, 'info');
            resetVisualTimer();
            multiResults = [];
            updateResultsDisplay();
            isWaitingForAutoStart = false;
            feedback('click');
            showToast('Reset desde dispositivo', 'info');
        }

        function parseBatteryMessage(msg) {
            const cm = msg.match(/Crono = ([\d.]+)v/);
            const lm = msg.match(/Laser = ([\d.]+)v/);
            if (cm) updateBatteryDisplay('batteryLocal', parseFloat(cm[1]));
            if (lm) updateBatteryDisplay('batteryRemote', parseFloat(lm[1]));
            addLog('🔋 ' + msg, 'info');
            feedback('click');
        }

        function updateBatteryDisplay(id, v) {
            const el = document.getElementById(id);
            el.textContent = v.toFixed(1) + 'v';
            el.classList.remove('good', 'medium', 'low');
            if (v >= 3.8) el.classList.add('good');
            else if (v >= 3.5) el.classList.add('medium');
            else {
                el.classList.add('low');
                if (v < 3.3) {
                    feedback('error');
                    showToast('⚠️ Batería baja!', 'error');
                }
            }
        }

        function parseTimeResult(msg) {
            stopVisualTimer();
            const parts = msg.split('PB:');
            let isNew = false;
            if (parts.length >= 1) renderTime(parts[0].trim());
            if (parts.length >= 2) {
                const pb = parts[1].trim();
                isNew = pb.includes('New');
                bestTime.innerHTML = `<span class="icon">${isNew ? '🎉' : '🏆'}</span><span>Mejor: ${pb.replace('New', '').trim()} ${isNew ? '¡NUEVO!' : ''}</span>`;
            }
            addLog('🏁 ' + msg, 'result');
            if (isNew) {
                feedback('newPB');
                showToast('🎉 ¡NUEVO RECORD!', 'success');
            } else {
                feedback('stop');
            }
        }

        function parseSplitOrSimpleTime(msg) {
            if (currentMode === 'SPLIT' && splitWaitingForStart) {
                splitWaitingForStart = false;
                startVisualTimer();
                addLog('🏁 ' + msg, 'result');
                feedback('result');
                return;
            }

            if (currentMode === 'SPLIT' && isRunning) {
                stopVisualTimer();
                renderTime(msg.trim());
                addLog('🏁 ' + msg, 'result');
                feedback('stop');
                return;
            }

            stopVisualTimer();
            renderTime(msg.trim());
            addLog('🏁 ' + msg, 'result');
            feedback('stop');
        }

        function parseMultiResult(msg) {
            const m = msg.match(/(\d+):\s*([\d:.]+)/);
            if (m) {
                multiResults.push({ position: parseInt(m[1]), time: m[2] });
                updateResultsDisplay();
                renderTime(m[2]);
                if (selectedRunners > 0 && multiResults.length >= selectedRunners) {
                    stopVisualTimer();
                    feedback('stop');
                    showToast('🏁 Carrera finalizada', 'success');
                } else {
                    feedback('result');
                }
            }
            addLog('🏃 ' + msg, 'result');
        }

        function parseModeMessage(msg) {
            const up = msg.toUpperCase();
            addLog(msg, 'info');
            resetVisualTimer();

            if (up.includes('SOLO') || up === 'SOLO') {
                currentMode = 'SOLO';
                multiInputCard.classList.remove('show');
                resultsCard.classList.remove('show');
                multiResults = [];
                selectedRunners = 0;
                document.querySelectorAll('.runner-btn').forEach(b => b.classList.remove('selected'));
                updateModeDisplay();
                feedback('mode');
            } else if (up.includes('MULTI') || up === 'MULTI') {
                currentMode = 'MULTI';
                isAutoMode = false;
                if (up.includes('RUNNER') || up.includes('NUMBER') || up.includes('?') || up.includes('CORREDOR')) {
                    multiInputCard.classList.add('show');
                } else {
                    multiInputCard.classList.remove('show');
                }
                multiResults = [];
                selectedRunners = 0;
                document.querySelectorAll('.runner-btn').forEach(b => b.classList.remove('selected'));
                updateResultsDisplay();
                updateModeDisplay();
                feedback('mode');
            } else if (up.includes('SPLIT') || up === 'SPLIT') {
                currentMode = 'SPLIT';
                isAutoMode = false;
                multiInputCard.classList.remove('show');
                resultsCard.classList.remove('show');
                splitWaitingForStart = false;
                selectedRunners = 0;
                updateModeDisplay();
                feedback('mode');
            }
        }

        function parseAutoMessage(msg) {
            const up = msg.toUpperCase();
            addLog(`⏱️ ${msg}`, 'info');

            let newAutoMode = null;
            if (up.includes('ON') && !up.includes('OFF')) {
                newAutoMode = true;
            } else if (up.includes('OFF')) {
                newAutoMode = false;
            }

            if (newAutoMode !== null) {
                isAutoMode = newAutoMode;

                updateModeDisplay();
                feedback('mode');
                showToast(isAutoMode ? 'AUTO activado' : 'AUTO desactivado', isAutoMode ? 'success' : 'info');

                if (!isAutoMode && isWaitingForAutoStart) {
                    isWaitingForAutoStart = false;
                    timerDisplay.classList.remove('waiting');
                    renderTime('00.00');
                }
            }
        }

        function updateResultsDisplay() {
            if (multiResults.length > 0 && currentMode === 'MULTI') {
                resultsCard.classList.add('show');
                resultsList.innerHTML = multiResults.map((r, i) =>
                    `<div class="result-item">
                        <span class="position ${i === 0 ? 'first' : i === 1 ? 'second' : i === 2 ? 'third' : ''}">${r.position}</span>
                        <span class="time-value">${r.time}</span>
                    </div>`
                ).join('');
            } else {
                resultsCard.classList.remove('show');
            }
        }

        function updateModeDisplay() {
            modeBadge.className = 'mode-badge';

            if (currentMode === 'SOLO') {
                if (isAutoMode) {
                    modeBadge.textContent = 'SOLO + AUTO';
                    modeBadge.classList.add('solo-auto');
                } else {
                    modeBadge.textContent = 'SOLO';
                }
            } else if (currentMode === 'MULTI') {
                modeBadge.classList.add('multi');
                if (selectedRunners > 0) {
                    modeBadge.textContent = `MULTI - ${selectedRunners}`;
                } else {
                    modeBadge.textContent = 'MULTI';
                }
            } else if (currentMode === 'SPLIT') {
                modeBadge.classList.add('split');
                modeBadge.textContent = 'SPLIT';
            }

            btnSolo.classList.remove('active');
            btnMulti.classList.remove('active');
            btnSplit.classList.remove('active');
            btnAutoMode.classList.remove('active');

            if (currentMode === 'SOLO') btnSolo.classList.add('active');
            if (currentMode === 'MULTI') btnMulti.classList.add('active');
            if (currentMode === 'SPLIT') btnSplit.classList.add('active');
            if (isAutoMode) btnAutoMode.classList.add('active');
        }

        // ============================================
        // LOG Y TOAST
        // ============================================
        function addLog(msg, type = 'info') {
            const ts = new Date().toLocaleTimeString('es-ES');
            logHistory.push({ time: `[${ts}]`, message: msg, type });
            if (logHistory.length > 500) logHistory.shift();

            const e = document.createElement('div');
            e.className = `log-entry ${type}`;
            e.innerHTML = `<span class="time ${showTimestamp ? 'show' : ''}">[${ts}]</span><span class="message">${msg}</span>`;
            logConsole.appendChild(e);

            while (logConsole.children.length > 100) {
                logConsole.removeChild(logConsole.firstChild);
            }

            logConsole.scrollTop = logConsole.scrollHeight;
        }

        function clearLog() {
            logConsole.innerHTML = '';
            logHistory = [];
            feedback('click');
        }

        function showToast(msg, type = 'info') {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = 'toast ' + type + ' show';
            setTimeout(() => t.classList.remove('show'), 3000);
        }

        // ============================================
        // INICIALIZACIÓN DE AUDIO (para móviles)
        // ============================================
        document.addEventListener('touchstart', () => {
            initAudioContext();
            if (vibrationEnabled && browserSupport.vibration) navigator.vibrate(1);
        }, { once: true });

        document.addEventListener('click', initAudioContext, { once: true });