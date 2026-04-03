# Discord The Last Meadow Auto Script

Automation script for The Last Meadow mini-games inside Discord.

## Features

- Auto-click Grass Toucher
- Auto-click available Activity buttons when no cooldown is active
- Auto-click Continue button
- Auto-click Go Back when the message `Looks like we're out of resources :(. Once someone collects some more, try again!` appears
- Ranger mode: auto-detects targets and clicks them quickly
- Paladin mode: auto-detects battle, tracks shield in real time, supports dual-projectile prioritization, blocks real mouse input inside Paladin arena
- Priest mode: auto-detects 3x3 glyph board and solves triplets by grouping matching glyph signatures
- Craft mode: reads and executes key sequences automatically
- Global stop command: `stopBot()`

## Requirements

- Discord client (or via browser at discord.com/app)

## Quick Start

1. Open Discord and navigate to The Last Meadow.
2. Open Developer Tools. Windows/Linux: `Ctrl + Shift + I`. macOS: `Cmd + Option + I`.
3. Open the Console tab. If paste is blocked, type `allow pasting` and press `Enter` button.
4. Paste the script below.
5. Press Enter.
<details>
  <summary>Script</summary>
  
  ```javascript
(function () {
    // Stop previous instance if present
    try {
        if (typeof window.stopBot === "function") window.stopBot();
    } catch {}

    const RANGER_HASH = "16fb25536f00a7996cbdf5bfff2ef0d09459f580af9e67d380263f5ead43055e";
    const GO_BACK_BTN_SEL = ".button__65fca.buttonWhite__65fca.clickable__5c90e";

    const SEL = {
        target: ".targetContainer_b6b008",
        clickable: ".clickable__5c90e",
        seq: ".sequences__34527",
        char: ".character__34527 img[alt]",
        cont: ".continueButtonWrapper__24749 .clickable__5c90e",
        activity: ".activityButton__8af73",
        cooldown: ".countdown__8af73",

        // Paladin
        projectile: ".projectile_cce732",
        shield: ".shield_cce732",
        palRoot: ".container__24749, .game__24749, .shaker_cce732",

        // Priest
        priestGame: ".game__5c62c",
        priestGrid: ".grid__0dcd3",
        priestItem: ".gridItem__0dcd3",
        priestMatched: ".matched__0dcd3",
        priestGlyph: ".gridAssetGlyph__0dcd3",

        // Modal
        modalResourceText: ".text_a2a25a, .text-lg\\/normal_cf4812, [data-text-variant='text-lg/normal']"
    };

    const CFG = {
        dragonMs: 50,
        activityMs: 50,
        pollMs: 25,
        settleMs: 20,
        keyDelayMs: 70,

        // Paladin
        palSmooth: 1,
        palAimY: 0.93,
        palTopDelta: 120,
        palDualCoverRatio: 1.08,
        palDefaultShieldW: 138,
        palDefaultProjW: 115,
        palMinShieldW: 96,
        blockRealMouse: true,

        // Priest
        priestClickDelayMs: 28,
        priestTripletDelayMs: 120,

        // Go Back modal
        goBackScanMs: 60,
        goBackCooldownMs: 250
    };

    const KEY_MAP = {
        ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37 },
        ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39 },
        ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, which: 38 },
        ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 },
        " ": { key: " ", code: "Space", keyCode: 32, which: 32 },
        Space: { key: " ", code: "Space", keyCode: 32, which: 32 }
    };

    const OUT_OF_RESOURCES_RE = /out of resources/i;
    const PRIEST_MATCHED_CLASS = "matched__0dcd3";

    const state = {
        mode: null,

        // Paladin
        palRaf: 0,
        palDrag: false,
        palRoot: null,
        mouseLockHandler: null,
        projectileMeta: new WeakMap(),
        liveProjectileSprites: new Set(),

        // Priest
        priestRaf: 0,
        priestBusy: false,

        // Shared
        craftBusy: false,
        lastSeqKey: "",
        clickedContinue: new WeakSet(),
        lastGoBackClickAt: 0
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

    function hardClick(el) {
        if (!el) return false;

        try {
            if (typeof el.focus === "function") el.focus({ preventScroll: true });
        } catch {}

        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;

        const clientX = r.left + r.width / 2;
        const clientY = r.top + r.height / 2;

        const under = document.elementFromPoint(clientX, clientY);
        const targets = [el, under].filter(Boolean);

        const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY };
        const mDown = { ...base, button: 0, buttons: 1 };
        const mUp = { ...base, button: 0, buttons: 0 };
        const pDown = { ...mDown, pointerId: 1, pointerType: "mouse", isPrimary: true };
        const pUp = { ...mUp, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const t of targets) {
            emitPointer(t, "pointerdown", pDown);
            emitMouse(t, "mousedown", mDown);
        }
        for (const t of targets) {
            emitPointer(t, "pointerup", pUp);
            emitMouse(t, "mouseup", mUp);
            emitMouse(t, "click", mUp);
        }

        try {
            el.click();
        } catch {}

        try {
            el.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            }));
            el.dispatchEvent(new KeyboardEvent("keyup", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            }));
        } catch {}

        return true;
    }

    function tryClickGoBackModal() {
        const now = Date.now();
        if (now - state.lastGoBackClickAt < CFG.goBackCooldownMs) return false;

        const warningNode = qa(SEL.modalResourceText).find((el) => {
            if (!isVisible(el)) return false;
            const text = (el.textContent || "").trim();
            return OUT_OF_RESOURCES_RE.test(text);
        });
        if (!warningNode) return false;

        const modalRoot =
            warningNode.closest("[role='dialog']") ||
            warningNode.closest("[class*='modal']") ||
            warningNode.closest("[class*='layer']") ||
            warningNode.parentElement ||
            document;

        let btn = q(GO_BACK_BTN_SEL, modalRoot);
        if (btn && !isVisible(btn)) btn = null;

        if (!btn) {
            btn = qa(GO_BACK_BTN_SEL).find((b) => isVisible(b)) || null;
        }
        if (!btn) return false;

        state.lastGoBackClickAt = now;
        hardClick(btn);
        setTimeout(() => hardClick(btn), 60);

        console.log("%c[Modal] Go Back clicked", "color:#ffcc66;font-weight:bold");
        return true;
    }

    // ---------- Battle detection ----------
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

    function hasPriestBoard() {
        const grid = q(SEL.priestGrid) || q(SEL.priestGame);
        if (!grid) return false;
        const items = qa(SEL.priestItem).filter(isVisible);
        return items.length >= 3;
    }

    function getBattleType() {
        if (getPaladinContext()) return "paladin";
        if (hasPriestBoard()) return "priest";
        if (qa(SEL.target).some(isVisible)) return "ranger";

        // Ranger fallback by class asset before battle starts
        for (const w of qa(SEL.activity)) {
            const img = w.querySelector("img.activityButtonAsset__8af73, img.asset__65fca");
            if (img && img.src && img.src.includes(RANGER_HASH)) return "ranger";
        }

        return null;
    }

    // ---------- Grass Toucher ----------
    const dragonBot = setInterval(() => {
        const el = q(".dragonClickable__8e80e") || q('img[alt="Grass Toucher"]');
        if (el) el.click();
    }, CFG.dragonMs);

    // ---------- Activity ----------
    const activityBot = setInterval(() => {
        for (const wrapper of qa(SEL.activity)) {
            if (q(SEL.cooldown, wrapper)) continue;
            q(SEL.clickable, wrapper)?.click();
        }
    }, CFG.activityMs);

    // ---------- Modal watcher ----------
    const goBackBot = setInterval(() => {
        tryClickGoBackModal();
    }, CFG.goBackScanMs);

    // ---------- Continue ----------
    function tryContinue() {
        const btn = q(SEL.cont);
        if (!btn || state.clickedContinue.has(btn)) return;
        state.clickedContinue.add(btn);
        btn.click();
        console.log("%c[Continue] Clicked", "color:#aaffff;font-weight:bold");
    }

    // ---------- Ranger ----------
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

    // ---------- Craft ----------
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

    // ---------- Paladin ----------
    function resetPaladinProjectileCache() {
        state.projectileMeta = new WeakMap();
        state.liveProjectileSprites = new Set();
    }

    function isResolvedProjectile(el, topMetric, src, now) {
        let meta = state.projectileMeta.get(el);

        if (!meta) {
            meta = {
                top: topMetric,
                ts: now,
                stableFrames: 0,
                moved: false,
                src: src || ""
            };
            state.projectileMeta.set(el, meta);
            return false;
        }

        const dy = Math.abs(topMetric - meta.top);
        const dt = now - meta.ts;

        if (dy > 0.7) {
            meta.moved = true;
            meta.stableFrames = 0;

            // Learn "alive" sprite while projectile is moving
            if (src) state.liveProjectileSprites.add(src);
        } else if (dt >= 20) {
            meta.stableFrames += 1;
        }

        const srcChanged = !!(meta.src && src && meta.src !== meta.src);
        const looksLikeImpactSprite =
            meta.moved &&
            !!src &&
            state.liveProjectileSprites.size > 0 &&
            !state.liveProjectileSprites.has(src);
        const frozenAfterMove = meta.moved && meta.stableFrames >= 2;

        const resolved = looksLikeImpactSprite || srcChanged || frozenAfterMove;

        meta.top = topMetric;
        meta.ts = now;
        meta.src = src || meta.src;

        return resolved;
    }

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
        const now = performance.now();

        for (const el of qa(SEL.projectile, root)) {
            if (!isVisible(el)) continue;

            const rect = el.getBoundingClientRect();
            const topMetric = num(el.style.top) ?? rect.bottom;
            const src = el.getAttribute("src") || "";

            // Skip projectiles already in impact animation
            if (isResolvedProjectile(el, topMetric, src, now)) continue;

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

    function choosePaladinTarget(threats, shieldW) {
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

    function getPaladinInputTargets(ctx) {
        return [ctx.shield, ctx.root, document, document.body, window];
    }

    function paladinPointerDown(ctx, x, y) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        const m = { ...base, button: 0, buttons: 1 };
        const p = { ...m, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const t of getPaladinInputTargets(ctx)) {
            emitPointer(t, "pointerdown", p);
            emitMouse(t, "mousedown", m);
        }

        state.palDrag = true;
    }

    function paladinPointerMove(ctx, x, y) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: 1 };
        const p = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const t of getPaladinInputTargets(ctx)) {
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
        const target = choosePaladinTarget(threats, shieldW);
        if (!target) return;

        if (target.logicalCenter !== null) {
            const currentLeft = num(ctx.shield.style.left);
            const desiredLeft = target.logicalCenter - shieldW / 2;
            const nextLeft =
                currentLeft === null ? desiredLeft : currentLeft + (desiredLeft - currentLeft) * CFG.palSmooth;

            ctx.shield.style.setProperty("left", `${nextLeft}px`, "important");
            ctx.shield.style.setProperty("transform", "none", "important");
        }

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
        resetPaladinProjectileCache();
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
        resetPaladinProjectileCache();
        state.palRoot = null;
    }

    // ---------- Priest ----------
    function getPriestGlyphSignature(tile) {
        const glyphRoot = q(SEL.priestGlyph, tile) || q(".gridAssetFront__0dcd3 svg", tile) || q("svg", tile);
        if (!glyphRoot) return null;

        const paths = qa("path", glyphRoot).map((p) => p.getAttribute("d") || "").join("|");
        if (paths && paths.length > 12) return paths;

        const html = (glyphRoot.innerHTML || "").replace(/\s+/g, "");
        return html || null;
    }

    function buildPriestGroups() {
        const items = qa(SEL.priestItem).filter((el) => isVisible(el) && !el.classList.contains(PRIEST_MATCHED_CLASS));
        const bySig = new Map();

        for (const item of items) {
            const sig = getPriestGlyphSignature(item);
            if (!sig) continue;
            if (!bySig.has(sig)) bySig.set(sig, []);
            bySig.get(sig).push(item);
        }

        return Array.from(bySig.values())
            .filter((g) => g.length >= 3)
            .map((g) => g.slice(0, 3));
    }

    async function solvePriestBoardOnce() {
        if (state.priestBusy || state.mode !== "priest") return;
        state.priestBusy = true;

        try {
            const groups = buildPriestGroups();
            if (!groups.length) return;

            for (const group of groups) {
                if (state.mode !== "priest") break;

                const live = group.filter(
                    (el) => document.contains(el) && isVisible(el) && !el.classList.contains(PRIEST_MATCHED_CLASS)
                );
                if (live.length < 3) continue;

                for (const tile of live) {
                    if (state.mode !== "priest") break;
                    hardClick(tile);
                    await sleep(CFG.priestClickDelayMs);
                }

                await sleep(CFG.priestTripletDelayMs);
            }
        } finally {
            state.priestBusy = false;
        }
    }

    function priestTick() {
        if (state.mode !== "priest") return;
        if (!hasPriestBoard()) return;
        solvePriestBoardOnce();
    }

    function priestLoop() {
        priestTick();
        state.priestRaf = requestAnimationFrame(priestLoop);
    }

    function startPriestBot() {
        if (state.priestRaf) return;
        state.priestBusy = false;
        state.priestRaf = requestAnimationFrame(priestLoop);
        console.log("%c[Priest] Bot started", "color:#a3ffcc;font-weight:bold");
    }

    function stopPriestBot() {
        if (state.priestRaf) {
            cancelAnimationFrame(state.priestRaf);
            state.priestRaf = 0;
        }
        state.priestBusy = false;
    }

    // ---------- Mode switch ----------
    function checkBattleMode() {
        const mode = getBattleType();
        if (mode === state.mode) return;

        state.mode = mode;

        if (mode === "paladin") {
            stopPriestBot();
            startPaladinBot();
            console.log("%c[Battle] PALADIN mode", "color:#88aaff;font-weight:bold");
            return;
        }

        if (mode === "priest") {
            stopPaladinBot();
            startPriestBot();
            console.log("%c[Battle] PRIEST mode", "color:#a3ffcc;font-weight:bold");
            return;
        }

        stopPaladinBot();
        stopPriestBot();

        if (mode === "ranger") {
            console.log("%c[Battle] RANGER mode", "color:#00ff88;font-weight:bold");
        }
    }

    // ---------- Observer ----------
    const observer = new MutationObserver((muts) => {
        tryClickGoBackModal();
        checkBattleMode();

        for (const m of muts) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;

                if (node.matches?.(SEL.target)) tryTarget(node);
                node.querySelectorAll?.(SEL.target).forEach(tryTarget);

                const seq = node.matches?.(SEL.seq) ? node : node.querySelector?.(SEL.seq);
                if (seq) doSequence(seq);

                if (node.matches?.(SEL.cont) || node.querySelector?.(SEL.cont)) tryContinue();

                // Fast reaction Paladin
                if (state.mode === "paladin") {
                    if (node.matches?.(SEL.projectile) || node.querySelector?.(SEL.projectile)) {
                        paladinTick();
                    }
                }

                // Fast reaction Priest
                if (state.mode === "priest") {
                    if (
                        node.matches?.(SEL.priestItem) ||
                        node.matches?.(SEL.priestGrid) ||
                        node.querySelector?.(SEL.priestItem)
                    ) {
                        priestTick();
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

    // ---------- Poll ----------
    const poll = setInterval(() => {
        tryClickGoBackModal();
        checkBattleMode();

        qa(SEL.target).forEach(tryTarget);

        const seq = q(SEL.seq);
        if (seq) doSequence(seq);
        else state.lastSeqKey = "";

        if (state.mode === "priest") priestTick();

        tryContinue();
    }, CFG.pollMs);

    // ---------- Stop ----------
    window.stopBot = () => {
        clearInterval(dragonBot);
        clearInterval(activityBot);
        clearInterval(goBackBot);
        clearInterval(poll);

        stopPaladinBot();
        stopPriestBot();
        observer.disconnect();

        console.log("%c[BOT] Stopped", "color:red;font-weight:bold");
    };

    // ---------- Init ----------
    checkBattleMode();

    const initSeq = q(SEL.seq);
    if (initSeq) doSequence(initSeq);

    tryClickGoBackModal();
    tryContinue();

    console.log("%c[The Last Meadow Auto Script] v1.0", "color:#00ff00;font-weight:bold;font-size:14px");
    console.log("%cStop command: stopBot()", "color:#ff9900");
})();
  ```
  
</details>

## Stop the Script

Run this in Console:

```js
stopBot();
```

## Configuration

You can tune behavior in the `CFG` object:

- `pollMs` for the main polling interval
- `keyDelayMs` for Craft key delay
- `palTopDelta` for Paladin second-projectile priority threshold
- `palDualCoverRatio` for Paladin dual-projectile center behavior
- `priestClickDelayMs` for Priest tile click cadence
- `priestTripletDelayMs` for Priest post-triplet spacing
- `goBackScanMs` for Go Back modal scan interval
- `goBackCooldownMs` for Go Back click debounce

## Notes

- The script relies on current Discord CSS class names.
- If Discord updates class names, selectors may need to be updated.
- Re-run the script after a page refresh or Discord update.

## Known issues

- None

## Disclaimer

Use at your own risk. This project is for educational and personal automation purposes.
