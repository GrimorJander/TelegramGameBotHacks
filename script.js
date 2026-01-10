const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
        const CHARACTERISTIC_UUID_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
        const CHARACTERISTIC_UUID_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

        let device = null, server = null, rxCharacteristic = null, txCharacteristic = null;
        let isConnected = false, currentMode = 'SOLO', isAutoMode = false, isRunning = false;
        let multiResults = [], selectedRunners = 0;
        let visualTimerInterval = null, visualTimerStart = null, splitWaitingForStart = false;

        // *** NUEVO: Estado de espera para modo AUTO ***
        let isWaitingForAutoStart = false;

        let soundEnabled = true, vibrationEnabled = true, showTimestamp = false;
        let audioContext = null, logHistory = [];
        let lastAutoChange = 0;

        const timerDisplay = document.getElementById('timerDisplay');
        const autoBadge = document.getElementById('autoBadge');

        function debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                if (!timeout) {
                    func.apply(this, args);
                }
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    timeout = null;
                }, wait);
            };
        }

        // ============================================
        // RENDER TIME CON DÍGITOS INDIVIDUALES
        // ============================================
        function renderTime(timeStr) {
            let html = '';
            for (let char of timeStr) {
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
            autoBadge.classList.remove('waiting');

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
            autoBadge.classList.remove('waiting');
        }

        function resetVisualTimer() {
            stopVisualTimer();
            renderTime('00.00');
            visualTimerStart = null;
            splitWaitingForStart = false;
            isWaitingForAutoStart = false;
            autoBadge.classList.remove('waiting');
        }

        // *** NUEVO: Función para mostrar estado de espera AUTO ***
        function setAutoWaitingState() {
            isWaitingForAutoStart = true;
            timerDisplay.classList.add('waiting');
            timerDisplay.classList.remove('running');
            autoBadge.classList.add('waiting');
            renderTime('00.00');
        }

        // Audio
        function initAudioContext() {
            if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
            if (audioContext.state === 'suspended') audioContext.resume();
        }

        function playBeep(f = 800, d = 150, v = 0.5) {
            if (!soundEnabled) return;
            try {
                initAudioContext();
                const o = audioContext.createOscillator(), g = audioContext.createGain();
                o.connect(g); g.connect(audioContext.destination);
                o.frequency.value = f; o.type = 'sine';
                g.gain.setValueAtTime(v, audioContext.currentTime);
                g.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + d/1000);
                o.start(); o.stop(audioContext.currentTime + d/1000);
            } catch(e){}
        }

        const sounds = {
            connect: () => { playBeep(600,100); setTimeout(()=>playBeep(800,100),120); setTimeout(()=>playBeep(1000,150),240); },
            disconnect: () => { playBeep(800,100); setTimeout(()=>playBeep(600,100),120); setTimeout(()=>playBeep(400,200),240); },
            start: () => playBeep(1200,100),
            stop: () => { playBeep(1000,80); setTimeout(()=>playBeep(1000,80),100); },
            newPB: () => { playBeep(800,100); setTimeout(()=>playBeep(1000,100),120); setTimeout(()=>playBeep(1200,100),240); setTimeout(()=>playBeep(1600,300),360); },
            mode: () => playBeep(900,150),
            error: () => playBeep(300,300,0.4),
            click: () => playBeep(1000,50,0.2),
            result: () => playBeep(880,100),
            send: () => playBeep(1100,80,0.3),
            autoGo: () => { playBeep(1000,100); setTimeout(()=>playBeep(1400,150),120); }
        };

        function vibrate(p) {
            if (!vibrationEnabled || !navigator.vibrate) return;
            try { setTimeout(()=>navigator.vibrate(p),0); } catch(e){}
        }

        const vibrations = { connect:[100,50,100,50,150], disconnect:[200,100,200], start:100, stop:[100,50,100], newPB:[100,50,100,50,100,100,200], mode:100, error:[200,100,200,100,200], click:30, result:[50,30,50], send:50, autoGo:[150,50,150] };

        function feedback(t) { if(sounds[t])sounds[t](); if(vibrations[t])vibrate(vibrations[t]); }

        function toggleSound() { soundEnabled = document.getElementById('chkSound').checked; localStorage.setItem('soundEnabled',soundEnabled); if(soundEnabled){initAudioContext();playBeep(800,80);} }
        function toggleVibration() { vibrationEnabled = document.getElementById('chkVibration').checked; localStorage.setItem('vibrationEnabled',vibrationEnabled); if(vibrationEnabled)vibrate(100); }
        function toggleTimestamp() { showTimestamp = document.getElementById('chkTimestamp').checked; localStorage.setItem('showTimestamp',showTimestamp); document.querySelectorAll('.log-entry .time').forEach(el=>el.classList.toggle('show',showTimestamp)); }

        function loadPreferences() {
            const s = localStorage.getItem('soundEnabled'), v = localStorage.getItem('vibrationEnabled'), t = localStorage.getItem('showTimestamp');
            if(s!==null) soundEnabled = s==='true';
            if(v!==null) vibrationEnabled = v==='true';
            if(t!==null) showTimestamp = t==='true';
            document.getElementById('chkSound').checked = soundEnabled;
            document.getElementById('chkVibration').checked = vibrationEnabled;
            document.getElementById('chkTimestamp').checked = showTimestamp;
        }

        const modeBadge = document.getElementById('modeBadge');
        const bestTime = document.getElementById('bestTime');
        const logConsole = document.getElementById('logConsole');
        const multiInputCard = document.getElementById('multiInputCard');
        const runnersSelector = document.getElementById('runnersSelector');
        const resultsCard = document.getElementById('resultsCard');
        const resultsList = document.getElementById('resultsList');
        const btnAuto = document.getElementById('btnAuto');
        const commandInput = document.getElementById('commandInput');

        function initRunnersSelector() {
            runnersSelector.innerHTML = '';
            for(let i=2;i<=10;i++) {
                const btn = document.createElement('button');
                btn.className = 'runner-btn';
                btn.textContent = i;
                btn.onclick = () => selectRunners(i);
                runnersSelector.appendChild(btn);
            }
        }

        function selectRunners(n) {
            feedback('click');
            selectedRunners = n;
            document.querySelectorAll('.runner-btn').forEach(b=>b.classList.toggle('selected',parseInt(b.textContent)===n));
            debouncedSendCommand(n.toString());
        }

        async function toggleConnection() { feedback('click'); initAudioContext(); if(isConnected) disconnect(); else await connect(); }

        async function connect() {
            try {
                addLog('Buscando CAIM...','info');
                if(!navigator.bluetooth) throw new Error('Bluetooth no soportado');
                device = await navigator.bluetooth.requestDevice({ filters:[{name:'CAIM'}], optionalServices:[SERVICE_UUID] });
                addLog('Conectando...','info');
                device.addEventListener('gattserverdisconnected', onDisconnected);
                server = await device.gatt.connect();
                const service = await server.getPrimaryService(SERVICE_UUID);
                rxCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_RX);
                txCharacteristic = await service.getCharacteristic(CHARACTERISTIC_UUID_TX);
                await txCharacteristic.startNotifications();
                txCharacteristic.addEventListener('characteristicvaluechanged', handleNotification);
                isConnected = true;
                updateConnectionUI(true);
                addLog('✅ Conectado','success');
                showToast('Conectado','success');
                feedback('connect');
                setButtonsEnabled(true);
                resetToDefaultState();
            } catch(e) { addLog('❌ '+e.message,'error'); showToast('Error','error'); feedback('error'); }
        }

        function resetToDefaultState() {
            currentMode = 'SOLO'; isAutoMode = false;
            multiInputCard.classList.remove('show'); resultsCard.classList.remove('show');
            multiResults = []; selectedRunners = 0; splitWaitingForStart = false;
            isWaitingForAutoStart = false;
            document.querySelectorAll('.runner-btn').forEach(b=>b.classList.remove('selected'));
            resetVisualTimer(); updateModeDisplay();
        }

        function disconnect() { if(device&&device.gatt.connected) device.gatt.disconnect(); onDisconnected(); }

        function onDisconnected() {
            isConnected = false; device = null; server = null; rxCharacteristic = null; txCharacteristic = null;
            updateConnectionUI(false); setButtonsEnabled(false);
            addLog('🔌 Desconectado','info'); showToast('Desconectado','error'); feedback('disconnect');
            resetToDefaultState();
        }

        function updateConnectionUI(c) {
            const ind = document.getElementById('statusIndicator'), txt = document.getElementById('statusText'), btn = document.getElementById('btnConnect');
            if(c) { ind.classList.add('connected'); txt.textContent='Conectado'; btn.textContent='Desconectar'; btn.classList.add('disconnect'); }
            else { ind.classList.remove('connected'); txt.textContent='Desconectado'; btn.textContent='Conectar'; btn.classList.remove('disconnect'); }
        }

        function setButtonsEnabled(e) {
            document.querySelectorAll('.btn').forEach(b=>{ if(b.id!=='btnConnect') b.disabled=!e; });
            document.getElementById('btnBattery').disabled = !e;
            commandInput.disabled = !e;
            document.getElementById('btnSendCommand').disabled = !e;
        }

        async function sendCommand(cmd) {
            if(!rxCharacteristic) { feedback('error'); return; }
            try {
                await rxCharacteristic.writeValue(new TextEncoder().encode(cmd));

                if(cmd === 'start') {
                    if(currentMode === 'SOLO' && isAutoMode) {
                        // *** MODO AUTO: No iniciar el contador, solo mostrar estado de espera ***
                        setAutoWaitingState();
                        feedback('click');
                        showToast('Esperando inicio AUTO...', 'info');
                    } else if(currentMode === 'SOLO' || currentMode === 'MULTI') {
                        // Modo normal: iniciar contador inmediatamente
                        startVisualTimer();
                        feedback('start');
                    } else if(currentMode === 'SPLIT') {
                        splitWaitingForStart = true;
                        renderTime('00.00');
                        feedback('click');
                    }
                } else if(cmd === 'reset') {
                    resetVisualTimer();
                    multiResults = [];
                    updateResultsDisplay();
                    feedback('click');
                } else {
                    feedback('click');
                }
            } catch(e) { addLog('❌ '+e.message,'error'); feedback('error'); }
        }

        async function sendCustomCommand() {
            const cmd = commandInput.value.trim();
            if(!cmd) return;
            if(!rxCharacteristic) { addLog('❌ Sin conexión','error'); feedback('error'); return; }
            try {
                await rxCharacteristic.writeValue(new TextEncoder().encode(cmd));
                addLog('📤 '+cmd,'sent'); feedback('send'); commandInput.value='';
            } catch(e) { addLog('❌ '+e.message,'error'); feedback('error'); }
        }

        function handleInputKeypress(e) { if(e.key==='Enter') sendCustomCommand(); }

        const debouncedSendCommand = debounce(sendCommand, 300);

        async function shareLog() {
            const txt = generateLogText();
            if(navigator.share) { try { await navigator.share({title:'CAIM',text:txt}); feedback('click'); } catch(e){ if(e.name!=='AbortError') fallbackShare(txt); } }
            else fallbackShare(txt);
        }

        function generateLogText() {
            const d = new Date().toLocaleDateString('es-ES'), t = new Date().toLocaleTimeString('es-ES');
            let txt = `🏃 CAIM\n📅 ${d} ${t}\n${'─'.repeat(30)}\n\n`;
            logHistory.forEach(e=>{ txt += showTimestamp ? `${e.time} ${e.message}\n` : `${e.message}\n`; });
            txt += `\n${'─'.repeat(30)}\nModo: ${currentMode}${isAutoMode?' (AUTO)':''}\n`;
            return txt;
        }

        function fallbackShare(txt) {
            if(navigator.clipboard) navigator.clipboard.writeText(txt).then(()=>{showToast('📋 Copiado','success');feedback('click');}).catch(()=>manualCopy(txt));
            else manualCopy(txt);
        }

        function manualCopy(txt) {
            const ta = document.createElement('textarea'); ta.value=txt; ta.style.cssText='position:fixed;opacity:0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); showToast('📋 Copiado','success'); } catch(e) { showToast('Error','error'); }
            document.body.removeChild(ta);
        }

        function handleNotification(event) {
            const msg = new TextDecoder().decode(event.target.value).trim();
            if(!msg) return;
            const up = msg.toUpperCase();

            // *** NUEVO: Detectar "AUTO GO" del ESP32 ***
            if(up.includes('AUTO GO') || up.includes('AUTO START') || up === 'GO') {
                handleAutoGo(msg);
                return;
            }

            // *** Detectar "AUTO Start pendiente" ***
            if(up.includes('AUTO') && (up.includes('PENDIENTE') || up.includes('PENDING'))) {
                addLog(`⏳ ${msg}`, 'info');
                return;
            }

            if(msg.includes('Crono =')&&msg.includes('Laser =')) parseBatteryMessage(msg);
            else if(msg.includes('PB:')) parseTimeResult(msg);
            else if(up.includes('AUTO') && (up.includes('ON') || up.includes('OFF'))) parseAutoMessage(msg);
            else if(up.includes('MODO')||up.includes('MODE')) parseModeMessage(msg);
            else if(up.includes('RUNNERS')||up.includes('RUNNER')) { addLog(msg,'info'); multiInputCard.classList.remove('show'); feedback('mode'); }
            else if(msg.match(/^\d+:\s*[\d:.]+/)) parseMultiResult(msg);
            else if(msg.match(/^[\d:.]+/)) parseSplitOrSimpleTime(msg);
            else if(msg!=='----------' && !up.includes('RESET')) addLog(msg,'result');
        }

        // *** NUEVO: Manejar señal "AUTO GO" del ESP32 ***
        function handleAutoGo(msg) {
            addLog(`🚀 ${msg}`, 'result');

            if(isWaitingForAutoStart) {
                // Ahora sí iniciamos el contador visual
                startVisualTimer();
                feedback('autoGo');
                showToast('¡GO!', 'success');
            }
        }

        function parseBatteryMessage(msg) {
            const cm = msg.match(/Crono = ([\d.]+)v/), lm = msg.match(/Laser = ([\d.]+)v/);
            if(cm) updateBatteryDisplay('batteryLocal',parseFloat(cm[1]));
            if(lm) updateBatteryDisplay('batteryRemote',parseFloat(lm[1]));
            addLog('🔋 '+msg,'info'); feedback('click');
        }

        function updateBatteryDisplay(id,v) {
            const el = document.getElementById(id);
            el.textContent = v.toFixed(1)+'v';
            el.classList.remove('good','medium','low');
            if(v>=3.8) el.classList.add('good');
            else if(v>=3.5) el.classList.add('medium');
            else { el.classList.add('low'); if(v<3.3){ feedback('error'); showToast('⚠️ Batería baja!','error'); } }
        }

        function parseTimeResult(msg) {
            stopVisualTimer();
            const parts = msg.split('PB:');
            let isNew = false;
            if(parts.length>=1) renderTime(parts[0].trim());
            if(parts.length>=2) {
                const pb = parts[1].trim();
                isNew = pb.includes('New');
                bestTime.innerHTML = `<span class="icon">${isNew?'🎉':'🏆'}</span><span>Mejor: ${pb.replace('New','').trim()} ${isNew?'¡NUEVO!':''}</span>`;
            }
            addLog('🏁 '+msg,'result');
            if(isNew) { feedback('newPB'); showToast('🎉 ¡NUEVO RECORD!','success'); } else feedback('stop');
        }

        function parseSplitOrSimpleTime(msg) {
            if(currentMode==='SPLIT'&&splitWaitingForStart) { splitWaitingForStart=false; startVisualTimer(); addLog('🏁 '+msg,'result'); feedback('result'); return; }
            if(currentMode==='SPLIT'&&isRunning) { stopVisualTimer(); renderTime(msg.trim()); addLog('🏁 '+msg,'result'); feedback('stop'); return; }
            stopVisualTimer(); renderTime(msg.trim()); addLog('🏁 '+msg,'result'); feedback('stop');
        }

        function parseMultiResult(msg) {
            const m = msg.match(/(\d+):\s*([\d:.]+)/);
            if(m) {
                multiResults.push({position:parseInt(m[1]),time:m[2]});
                updateResultsDisplay();
                renderTime(m[2]);
                if(selectedRunners>0&&multiResults.length>=selectedRunners) { stopVisualTimer(); feedback('stop'); showToast('🏁 Finalizado','success'); }
                else feedback('result');
            }
            addLog('🏃 '+msg,'result');
        }

        function parseModeMessage(msg) {
            const up = msg.toUpperCase();
            addLog(msg,'info'); resetVisualTimer();

            if(up.includes('SOLO')) {
                currentMode='SOLO'; isAutoMode=false; multiInputCard.classList.remove('show'); resultsCard.classList.remove('show');
                multiResults=[]; selectedRunners=0; document.querySelectorAll('.runner-btn').forEach(b=>b.classList.remove('selected'));
                updateModeDisplay(); feedback('mode');
            } else if(up.includes('MULTI')) {
                currentMode='MULTI'; isAutoMode=false;
                if(up.includes('RUNNER')||up.includes('NUMBER')||up.includes('?')) multiInputCard.classList.add('show');
                else multiInputCard.classList.remove('show');
                multiResults=[]; updateResultsDisplay(); updateModeDisplay(); feedback('mode');
            } else if(up.includes('SPLIT')) {
                currentMode='SPLIT'; isAutoMode=false; multiInputCard.classList.remove('show'); splitWaitingForStart=false;
                updateModeDisplay(); feedback('mode');
            }
        }

        function parseAutoMessage(msg) {
            const up = msg.toUpperCase();
            const now = Date.now();

            addLog(`⏱️ ${msg}`, 'info');

            // Debounce
            if(now - lastAutoChange < 500) return;

            let newAutoMode = null;
            if(up.includes('ON') && !up.includes('OFF')) newAutoMode = true;
            else if(up.includes('OFF')) newAutoMode = false;

            if(newAutoMode !== null && newAutoMode !== isAutoMode) {
                isAutoMode = newAutoMode;
                lastAutoChange = now;
                btnAuto.classList.toggle('active', isAutoMode);
                updateModeDisplay();
                feedback('mode');
                showToast(isAutoMode ? 'AUTO activado' : 'AUTO desactivado', isAutoMode ? 'success' : 'info');

                // Si se desactiva AUTO mientras esperamos, cancelar la espera
                if(!isAutoMode && isWaitingForAutoStart) {
                    isWaitingForAutoStart = false;
                    timerDisplay.classList.remove('waiting');
                    autoBadge.classList.remove('waiting');
                }
            }
        }

        function updateResultsDisplay() {
            if(multiResults.length>0&&currentMode==='MULTI') {
                resultsCard.classList.add('show');
                resultsList.innerHTML = multiResults.map((r,i)=>`<div class="result-item"><span class="position ${i===0?'first':i===1?'second':i===2?'third':''}">${r.position}</span><span class="time-value">${r.time}</span></div>`).join('');
            } else resultsCard.classList.remove('show');
        }

        function updateModeDisplay() {
            modeBadge.className = 'mode-badge';
            if(currentMode==='SOLO') { modeBadge.textContent='SOLO'; btnAuto.style.display='flex'; }
            else if(currentMode==='MULTI') { modeBadge.textContent='MULTI'; modeBadge.classList.add('multi'); btnAuto.style.display='none'; isAutoMode=false; }
            else if(currentMode==='SPLIT') { modeBadge.textContent='SPLIT'; modeBadge.classList.add('split'); btnAuto.style.display='none'; isAutoMode=false; }

            if(isAutoMode&&currentMode==='SOLO') autoBadge.classList.add('show');
            else { autoBadge.classList.remove('show'); autoBadge.classList.remove('waiting'); }

            btnAuto.classList.toggle('active',isAutoMode);
        }

        function addLog(msg,type='info') {
            const ts = new Date().toLocaleTimeString('es-ES');
            logHistory.push({time:`[${ts}]`,message:msg,type});
            if(logHistory.length>500) logHistory.shift();
            const e = document.createElement('div');
            e.className = `log-entry ${type}`;
            e.innerHTML = `<span class="time ${showTimestamp?'show':''}">[${ts}]</span><span class="message">${msg}</span>`;
            logConsole.appendChild(e);
            logConsole.scrollTop = logConsole.scrollHeight;
        }

        function clearLog() { logConsole.innerHTML=''; logHistory=[]; feedback('click'); }

        function showToast(msg,type='info') {
            const t = document.getElementById('toast');
            t.textContent = msg;
            t.className = 'toast '+type+' show';
            setTimeout(()=>t.classList.remove('show'),3000);
        }

        document.addEventListener('DOMContentLoaded',()=>{
            initRunnersSelector();
            loadPreferences();
            renderTime('00.00');
            if(!navigator.bluetooth) addLog('⚠️ Bluetooth no soportado','error');
        });

        document.addEventListener('touchstart',()=>{ initAudioContext(); if(vibrationEnabled&&navigator.vibrate)navigator.vibrate(1); },{once:true});
        document.addEventListener('click',initAudioContext,{once:true});