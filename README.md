# Discord The Last Meadow Auto Script

Automation script for The Last Meadow mini-games inside Discord.

## Features

- Auto-click Dragon activity targets
- Auto-click available Activity buttons (when no cooldown is active)
- Auto-click Continue button
- Archer mode:
  - Auto-detects targets
  - Fast target clicking
- Paladin mode:
  - Auto-detects Paladin battle
  - Real-time shield tracking
  - Improved dual-projectile handling (prioritizes nearest threats, can center between top two)
  - Blocks real mouse control during Paladin to prevent accidental shield drift
- Craft mode:
  - Auto-reads key sequence from UI
  - Sends key inputs automatically
- Global stop command:
  - `stopBot()`

## Requirements

- Discord in a desktop browser (or webview with DevTools access)
- Browser Developer Tools (Console tab)

## Quick Start

1. Open Discord and navigate to The Last Meadow.
2. Open Developer Tools:
   - Windows/Linux: `Ctrl + Shift + I`
   - macOS: `Cmd + Option + I`
3. Open the **Console** tab.
4. Paste the full script.
<details>
  <summary>Script</summary>
  
  ```javascript
  (function () {
    // Stop previous instance if present
    try {
        if (typeof window.stopBot === "function") window.stopBot();
    } catch {}

    const ARCHER_HASH = "16fb25536f00a7996cbdf5bfff2ef0d09459f580af9e67d380263f5ead43055e";

    const SEL = {
        target: ".targetContainer_b6b008",
        clickable: ".clickable__5c90e",
        seq: ".sequences__34527",
        char: ".character__34527 img[alt]",
        cont: ".continueButtonWrapper__24749 .clickable__5c90e",
        activity: ".activityButton__8af73",
        cooldown: ".countdown__8af73",

        projectile: ".projectile_cce732",
        shield: ".shield_cce732",
        palRoot: ".container__24749, .game__24749, .shaker_cce732"
    };

    const CFG = {
        dragonMs: 50,
        activityMs: 50,
        pollMs: 25,
        settleMs: 20,
        keyDelayMs: 70,

        palSmooth: 0.88,
        palAimY: 0.93,
        palTopDelta: 120,
        palDualCoverRatio: 1.08,
        palDefaultShieldW: 138,
        palDefaultProjW: 115,
        palMinShieldW: 96,
        blockRealMouse: true
    };

    const KEY_MAP = {
        ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37 },
        ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39 },
        ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, which: 38 },
        ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 },
        " ": { key: " ", code: "Space", keyCode: 32, which: 32 },
        Space: { key: " ", code: "Space", keyCode: 32, which: 32 }
    };

    const state = {
        mode: null,
        palRaf: 0,
        palDrag: false,
        palRoot: null,
        mouseLockHandler: null,
        craftBusy: false,
        lastSeqKey: "",
        clickedContinue: new WeakSet()
    };

    const q = (s, r = document) => r.querySelector(s);
    const qa = (s, r = document) => Array.from(r.querySelectorAll(s));
    const num = (v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function isVisible(el) {
        if (!(el instanceof Element)) return false;
        if (!document.contains(el)) return false;

        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;

        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;

        const op = parseFloat(cs.opacity || "1");
        if (Number.isFinite(op) && op < 0.02) return false;

        return true;
    }

    function normalizeKeyName(name) {
        if (!name) return null;
        const k = String(name).trim();
        if (k === "Space" || k === "Spacebar") return " ";
        return k;
    }

    function sendKey(target, keyName) {
        if (!target) return;
        const key = normalizeKeyName(keyName);
        const def = KEY_MAP[key];
        if (!def) return;

        const opts = { bubbles: true, cancelable: true, ...def };
        try {
            target.dispatchEvent(new KeyboardEvent("keydown", opts));
            target.dispatchEvent(new KeyboardEvent("keypress", opts));
            target.dispatchEvent(new KeyboardEvent("keyup", opts));
        } catch {}
    }

    function getPaladinContext() {
        let best = null;

        for (const root of qa(SEL.palRoot)) {
            if (!isVisible(root)) continue;

            const shield = q(SEL.shield, root);
            if (!shield || !isVisible(shield)) continue;

            const rect = root.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 80) continue;

            const projectiles = qa(SEL.projectile, root).filter(isVisible);
            const score = projectiles.length * 1000000 + rect.width * rect.height;

            if (!best || score > best.score) {
                best = { root, shield, rect, projectiles, score };
            }
        }

        return best;
    }

    function getBattleType() {
        const pal = getPaladinContext();
        if (pal) return "paladin";

        if (qa(SEL.target).some(isVisible)) return "archer";

        for (const w of qa(SEL.activity)) {
            const img = w.querySelector("img.activityButtonAsset__8af73, img.asset__65fca");
            if (img && img.src && img.src.includes(ARCHER_HASH)) return "archer";
        }

        return null;
    }

    // Dragon
    const dragonBot = setInterval(() => {
        const el = q(".dragonClickable__8e80e") || q('img[alt="Grass Toucher"]');
        if (el) el.click();
    }, CFG.dragonMs);

    // Activity buttons
    const activityBot = setInterval(() => {
        for (const wrapper of qa(SEL.activity)) {
            if (q(SEL.cooldown, wrapper)) continue;
            q(SEL.clickable, wrapper)?.click();
        }
    }, CFG.activityMs);

    // Continue
    function tryContinue() {
        const btn = q(SEL.cont);
        if (!btn || state.clickedContinue.has(btn)) return;
        state.clickedContinue.add(btn);
        btn.click();
        console.log("%c[Continue] Clicked", "color:#aaffff;font-weight:bold");
    }

    // Archer
    const hitTargets = new WeakSet();

    function fireTarget(el) {
        if (!document.contains(el)) return;
        const btn = q(SEL.clickable, el) || el;
        btn.focus({ preventScroll: true });
        btn.click();
        sendKey(btn, " ");
        sendKey(document.body, " ");
    }

    function tryTarget(el) {
        if (hitTargets.has(el)) return;
        try {
            if (!el.matches(SEL.target)) return;
        } catch {
            return;
        }
        hitTargets.add(el);
        setTimeout(() => fireTarget(el), CFG.settleMs);
    }

    // Craft
    async function doSequence(seqEl) {
        const keys = qa(SEL.char, seqEl)
            .map((img) => normalizeKeyName(img.getAttribute("alt")))
            .filter((k) => KEY_MAP[k]);

        if (!keys.length) return;

        const seqKey = keys.join(",");
        if (state.craftBusy || seqKey === state.lastSeqKey) return;

        state.craftBusy = true;
        state.lastSeqKey = seqKey;

        console.log("%c[Craft] Sequence:", "color:#ffff00;font-weight:bold", keys.join(" -> "));

        for (const key of keys) {
            sendKey(document, key);
            sendKey(document.body, key);
            const active = document.activeElement;
            if (active && active !== document.body) sendKey(active, key);
            await sleep(CFG.keyDelayMs);
        }

        state.craftBusy = false;
    }

    // Paladin helpers
    function getShieldWidthLogical(shield) {
        return Math.max(
            CFG.palMinShieldW,
            num(shield.style.width) ??
                num(getComputedStyle(shield).width) ??
                CFG.palDefaultShieldW
        );
    }

    function getProjectileThreats(root) {
        const list = [];

        for (const el of qa(SEL.projectile, root)) {
            if (!isVisible(el)) continue;

            const rect = el.getBoundingClientRect();
            const topMetric = num(el.style.top) ?? rect.bottom;

            const leftLogical = num(el.style.left);
            const widthLogical = num(el.style.width) ?? CFG.palDefaultProjW;
            const logicalCenter = leftLogical === null ? null : leftLogical + widthLogical / 2;

            const clientCenter = rect.left + rect.width / 2;

            list.push({
                el,
                topMetric,
                logicalCenter,
                clientCenter
            });
        }

        list.sort((a, b) => b.topMetric - a.topMetric);
        return list;
    }

    function chooseTarget(threats, shieldW) {
        if (!threats.length) return null;
        const a = threats[0];
        const b = threats[1];

        if (!b) {
            return {
                logicalCenter: a.logicalCenter,
                clientCenter: a.clientCenter
            };
        }

        const closeInY = (a.topMetric - b.topMetric) <= CFG.palTopDelta;

        if (
            closeInY &&
            a.logicalCenter !== null &&
            b.logicalCenter !== null &&
            Math.abs(a.logicalCenter - b.logicalCenter) <= shieldW * CFG.palDualCoverRatio
        ) {
            return {
                logicalCenter: (a.logicalCenter + b.logicalCenter) / 2,
                clientCenter: (a.clientCenter + b.clientCenter) / 2
            };
        }

        return {
            logicalCenter: a.logicalCenter,
            clientCenter: a.clientCenter
        };
    }

    function emitPointer(target, type, opts) {
        if (!target || typeof target.dispatchEvent !== "function") return;
        if (typeof PointerEvent !== "function") return;
        try {
            target.dispatchEvent(new PointerEvent(type, opts));
        } catch {}
    }

    function emitMouse(target, type, opts) {
        if (!target || typeof target.dispatchEvent !== "function") return;
        try {
            target.dispatchEvent(new MouseEvent(type, opts));
        } catch {}
    }

    function getInputTargets(ctx) {
        return [ctx.shield, ctx.root, document, document.body, window];
    }

    function paladinPointerDown(ctx, x, y) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        const m = { ...base, button: 0, buttons: 1 };
        const p = { ...m, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const t of getInputTargets(ctx)) {
            emitPointer(t, "pointerdown", p);
            emitMouse(t, "mousedown", m);
        }

        state.palDrag = true;
    }

    function paladinPointerMove(ctx, x, y) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: 1 };
        const p = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const t of getInputTargets(ctx)) {
            emitPointer(t, "pointermove", p);
            emitMouse(t, "mousemove", base);
        }
    }

    function paladinPointerUp() {
        if (!state.palDrag) return;

        const root = state.palRoot;
        const rect = root?.getBoundingClientRect();
        const x = rect ? rect.left + rect.width / 2 : 0;
        const y = rect ? rect.top + rect.height * CFG.palAimY : 0;

        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        const m = { ...base, button: 0, buttons: 0 };
        const p = { ...m, pointerId: 1, pointerType: "mouse", isPrimary: true };

        const targets = [root, document, document.body, window];
        for (const t of targets) {
            emitPointer(t, "pointerup", p);
            emitMouse(t, "mouseup", m);
        }

        state.palDrag = false;
    }

    function mouseEventInsidePaladin(e) {
        const root = state.palRoot;
        if (!root) return true;
        if (!("clientX" in e) || !("clientY" in e)) return true;

        const r = root.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    function enableMouseLock() {
        if (!CFG.blockRealMouse || state.mouseLockHandler) return;

        state.mouseLockHandler = (e) => {
            if (state.mode !== "paladin") return;
            if (!e.isTrusted) return;
            if (!mouseEventInsidePaladin(e)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };

        const events = ["pointermove", "mousemove", "dragstart", "pointerdown", "mousedown", "pointerup", "mouseup"];
        for (const ev of events) {
            window.addEventListener(ev, state.mouseLockHandler, true);
            document.addEventListener(ev, state.mouseLockHandler, true);
        }
    }

    function disableMouseLock() {
        if (!state.mouseLockHandler) return;

        const events = ["pointermove", "mousemove", "dragstart", "pointerdown", "mousedown", "pointerup", "mouseup"];
        for (const ev of events) {
            window.removeEventListener(ev, state.mouseLockHandler, true);
            document.removeEventListener(ev, state.mouseLockHandler, true);
        }

        state.mouseLockHandler = null;
    }

    function paladinTick() {
        const ctx = getPaladinContext();
        if (!ctx) return;

        state.palRoot = ctx.root;

        const threats = getProjectileThreats(ctx.root);
        if (!threats.length) return;

        const shieldW = getShieldWidthLogical(ctx.shield);
        const target = chooseTarget(threats, shieldW);
        if (!target) return;

        // Direct style fallback
        if (target.logicalCenter !== null) {
            const currentLeft = num(ctx.shield.style.left);
            const desiredLeft = target.logicalCenter - shieldW / 2;
            const nextLeft = currentLeft === null
                ? desiredLeft
                : currentLeft + (desiredLeft - currentLeft) * CFG.palSmooth;

            ctx.shield.style.setProperty("left", `${nextLeft}px`, "important");
            ctx.shield.style.setProperty("transform", "none", "important");
        }

        // Virtual pointer feed for internal game logic
        const x = target.clientCenter;
        const y = ctx.rect.top + ctx.rect.height * CFG.palAimY;

        if (!state.palDrag) paladinPointerDown(ctx, x, y);
        paladinPointerMove(ctx, x, y);
    }

    function paladinLoop() {
        paladinTick();
        state.palRaf = requestAnimationFrame(paladinLoop);
    }

    function startPaladinBot() {
        if (state.palRaf) return;
        enableMouseLock();
        state.palRaf = requestAnimationFrame(paladinLoop);
        console.log("%c[Paladin] Bot started", "color:#88aaff;font-weight:bold");
    }

    function stopPaladinBot() {
        if (state.palRaf) {
            cancelAnimationFrame(state.palRaf);
            state.palRaf = 0;
        }
        paladinPointerUp();
        disableMouseLock();
        state.palRoot = null;
    }

    function checkBattleMode() {
        const mode = getBattleType();
        if (mode === state.mode) return;

        state.mode = mode;

        if (mode === "paladin") {
            startPaladinBot();
            console.log("%c[Battle] PALADIN mode", "color:#88aaff;font-weight:bold");
            return;
        }

        stopPaladinBot();

        if (mode === "archer") {
            console.log("%c[Battle] ARCHER mode", "color:#00ff88;font-weight:bold");
        }
    }

    const observer = new MutationObserver((muts) => {
        checkBattleMode();

        for (const m of muts) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;

                if (node.matches?.(SEL.target)) tryTarget(node);
                node.querySelectorAll?.(SEL.target).forEach(tryTarget);

                const seq = node.matches?.(SEL.seq) ? node : node.querySelector?.(SEL.seq);
                if (seq) doSequence(seq);

                if (node.matches?.(SEL.cont) || node.querySelector?.(SEL.cont)) tryContinue();

                // Fast immediate response to freshly spawned projectiles
                if (state.mode === "paladin") {
                    if (node.matches?.(SEL.projectile) || node.querySelector?.(SEL.projectile)) {
                        paladinTick();
                    }
                }
            }

            if (m.type === "childList" && m.target instanceof Element) {
                if (m.target.closest?.(SEL.seq) || m.target.matches?.(SEL.seq)) {
                    doSequence(m.target.closest(SEL.seq) || m.target);
                }
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const poll = setInterval(() => {
        checkBattleMode();

        qa(SEL.target).forEach(tryTarget);

        const seq = q(SEL.seq);
        if (seq) doSequence(seq);
        else state.lastSeqKey = "";

        tryContinue();
    }, CFG.pollMs);

    window.stopBot = () => {
        clearInterval(dragonBot);
        clearInterval(activityBot);
        clearInterval(poll);

        stopPaladinBot();
        observer.disconnect();

        console.log("%c[BOT] Stopped", "color:red;font-weight:bold");
    };

    // Init
    checkBattleMode();

    const initSeq = q(SEL.seq);
    if (initSeq) doSequence(initSeq);

    tryContinue();

    console.log("%c[The Last Meadow Auto Script] v21", "color:#00ff00;font-weight:bold;font-size:14px");
    console.log("%cNo God Mode", "color:#88ccff");
    console.log("%cReal mouse shield control is blocked in Paladin", "color:#88ccff");
    console.log("%cStop command: stopBot()", "color:#ff9900");
})();
  ```
  
</details>
5. Press `Enter`.

## Stop the Script

Run this in Console:

```js
stopBot();
```

## Configuration

You can tune behavior in the CFG object at the top of the script:

- POLL_MS - main polling interval
- PALADIN_SECONDARY_TOP_DELTA - how close the second projectile must be to become dual-priority
- PALADIN_DUAL_COVER_RATIO - whether shield should center between two close threats
- KEY_DELAY_MS - delay between Craft key inputs

## Notes

- The script relies on current Discord CSS class names.
- If Discord updates class names, selectors may need to be updated.
- Re-run the script after a page refresh or Discord update.

## Disclaimer

Use at your own risk. This project is for educational and personal automation purposes.
