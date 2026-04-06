// ==UserScript==
// @name         Last Meadow Auto Script
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Auto-player for Last Meadow game (Paladin/Priest/Ranger modes, Craft sequences)
// @author       REALMWTH
// @match        https://discordapp.com/channels/*
// @match        https://discord.com/channels/*
// @updateURL    https://raw.githubusercontent.com/REALMWTH/Discord-The-Last-Meadow-Auto-Script/refs/heads/main/last-meadow-auto.js
// @downloadURL  https://raw.githubusercontent.com/REALMWTH/Discord-The-Last-Meadow-Auto-Script/refs/heads/main/last-meadow-auto.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    // Stop previous instance if present.
    try {
        if (typeof window.stopBot === "function") window.stopBot();
    } catch {}

    const RANGER_HASH = "16fb25536f00a7996cbdf5bfff2ef0d09459f580af9e67d380263f5ead43055e";
    const GO_BACK_BTN_SEL = ".button__65fca.buttonWhite__65fca.clickable__5c90e";
    const PRIEST_MATCHED_CLASS = "matched__0dcd3";
    const OUT_OF_RESOURCES_RE = /out of resources/i;

    const SELECTORS = Object.freeze({
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
        priestGlyph: ".gridAssetGlyph__0dcd3",

        // Modal
        modalResourceText: ".text_a2a25a, .text-lg\\/normal_cf4812, [data-text-variant='text-lg/normal']"
    });

    const CONFIG = Object.freeze({
        dragonMs: 50,
        activityMs: 50,
        pollMs: 25,
        settleMs: 20,
        keyDelayMs: 70,
        craftRetrySameSeqMs: 700,
        craftPostKeySettleMs: 30,
        craftStepAckTimeoutMs: 280,
        craftStepPollMs: 20,
        craftRetryWholeMax: 3,
        craftRetryBackoffMs: 140,

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
    });

    const KEY_MAP = Object.freeze({
        ArrowLeft: Object.freeze({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37 }),
        ArrowRight: Object.freeze({ key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39 }),
        ArrowUp: Object.freeze({ key: "ArrowUp", code: "ArrowUp", keyCode: 38, which: 38 }),
        ArrowDown: Object.freeze({ key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 }),
        " ": Object.freeze({ key: " ", code: "Space", keyCode: 32, which: 32 }),
        Space: Object.freeze({ key: " ", code: "Space", keyCode: 32, which: 32 })
    });

    const MOUSE_LOCK_EVENTS = Object.freeze([
        "pointermove",
        "mousemove",
        "dragstart",
        "pointerdown",
        "mousedown",
        "pointerup",
        "mouseup"
    ]);

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
        lastSeqSentAt: 0,
        clickedContinue: new WeakSet(),
        lastGoBackClickAt: 0,

        // Intervals
        dragonTimer: 0,
        activityTimer: 0,
        goBackTimer: 0,
        pollTimer: 0,

        observer: null
    };

    const queryOne = (selector, root = document) => root.querySelector(selector);
    const queryAll = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function toNum(value) {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
    }

    function isVisible(el) {
        if (!(el instanceof Element)) return false;
        if (!document.contains(el)) return false;

        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;

        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;

        const opacity = parseFloat(style.opacity || "1");
        if (Number.isFinite(opacity) && opacity < 0.02) return false;

        return true;
    }

    function normalizeKeyName(name) {
        if (!name) return null;
        const trimmed = String(name).trim();
        if (trimmed === "Space" || trimmed === "Spacebar") return " ";
        return trimmed;
    }

    function resolveEventCtor(target, ctorName) {
        const targetWin =
            target?.ownerDocument?.defaultView ||
            target?.defaultView ||
            (target?.window === target ? target : window);

        return targetWin?.[ctorName] || window?.[ctorName] || globalThis?.[ctorName] || null;
    }

    function dispatchSafe(target, ctorName, type, options) {
        if (!target || typeof target.dispatchEvent !== "function") return false;

        const EventCtor = resolveEventCtor(target, ctorName);
        if (typeof EventCtor !== "function") return false;

        try {
            target.dispatchEvent(new EventCtor(type, options));
            return true;
        } catch {
            return false;
        }
    }

    function emitPointer(target, type, options) {
        dispatchSafe(target, "PointerEvent", type, options);
    }

    function emitMouse(target, type, options) {
        dispatchSafe(target, "MouseEvent", type, options);
    }

    function sendKey(target, keyName) {
        if (!target) return 0;

        const key = normalizeKeyName(keyName);
        if (!key) return 0;

        const definition = KEY_MAP[key];
        if (!definition) return 0;

        const options = {
            bubbles: true,
            cancelable: true,
            location: 0,
            repeat: false,
            altKey: false,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false,
            isComposing: false,
            ...definition
        };

        let sent = 0;
        sent += dispatchSafe(target, "KeyboardEvent", "keydown", options) ? 1 : 0;
        sent += dispatchSafe(target, "KeyboardEvent", "keypress", options) ? 1 : 0;
        sent += dispatchSafe(target, "KeyboardEvent", "keyup", options) ? 1 : 0;
        return sent;
    }

    function hardClick(el) {
        if (!el) return false;

        try {
            if (typeof el.focus === "function") el.focus({ preventScroll: true });
        } catch {}

        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;

        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;

        const under = document.elementFromPoint(clientX, clientY);
        const targets = [el, under].filter(Boolean);

        const base = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX,
            clientY
        };

        const mouseDown = { ...base, button: 0, buttons: 1 };
        const mouseUp = { ...base, button: 0, buttons: 0 };
        const pointerDown = { ...mouseDown, pointerId: 1, pointerType: "mouse", isPrimary: true };
        const pointerUp = { ...mouseUp, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const target of targets) {
            emitPointer(target, "pointerdown", pointerDown);
            emitMouse(target, "mousedown", mouseDown);
        }

        for (const target of targets) {
            emitPointer(target, "pointerup", pointerUp);
            emitMouse(target, "mouseup", mouseUp);
            emitMouse(target, "click", mouseUp);
        }

        try {
            el.click();
        } catch {}

        dispatchSafe(el, "KeyboardEvent", "keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        });

        dispatchSafe(el, "KeyboardEvent", "keyup", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        });

        return true;
    }

    function getBattleType() {
        if (getPaladinContext()) return "paladin";
        if (hasPriestBoard()) return "priest";
        if (queryAll(SELECTORS.target).some(isVisible)) return "ranger";

        // Ranger fallback by class asset before battle starts.
        for (const wrapper of queryAll(SELECTORS.activity)) {
            const img = wrapper.querySelector("img.activityButtonAsset__8af73, img.asset__65fca");
            if (img && img.src && img.src.includes(RANGER_HASH)) return "ranger";
        }

        return null;
    }

    function tryClickGoBackModal() {
        const now = Date.now();
        if (now - state.lastGoBackClickAt < CONFIG.goBackCooldownMs) return false;

        const warningNode = queryAll(SELECTORS.modalResourceText).find((el) => {
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

        let button = queryOne(GO_BACK_BTN_SEL, modalRoot);
        if (button && !isVisible(button)) button = null;

        if (!button) {
            button = queryAll(GO_BACK_BTN_SEL).find((candidate) => isVisible(candidate)) || null;
        }

        if (!button) return false;

        state.lastGoBackClickAt = now;

        hardClick(button);
        setTimeout(() => hardClick(button), 60);

        console.log("%c[Modal] Go Back clicked", "color:#ffcc66;font-weight:bold");
        return true;
    }

    // ---------- Battle detection ----------
    function getPaladinContext() {
        let best = null;

        for (const root of queryAll(SELECTORS.palRoot)) {
            if (!isVisible(root)) continue;

            const shield = queryOne(SELECTORS.shield, root);
            if (!shield || !isVisible(shield)) continue;

            const rect = root.getBoundingClientRect();
            if (rect.width < 80 || rect.height < 80) continue;

            const projectiles = queryAll(SELECTORS.projectile, root).filter(isVisible);
            const score = projectiles.length * 1000000 + rect.width * rect.height;

            if (!best || score > best.score) {
                best = { root, shield, rect, projectiles, score };
            }
        }

        return best;
    }

    function hasPriestBoard() {
        const grid = queryOne(SELECTORS.priestGrid) || queryOne(SELECTORS.priestGame);
        if (!grid) return false;

        const items = queryAll(SELECTORS.priestItem).filter(isVisible);
        return items.length >= 3;
    }

    // ---------- Grass Toucher ----------
    function runDragonTick() {
        const el = queryOne(".dragonClickable__8e80e") || queryOne('img[alt="Grass Toucher"]');
        if (el) el.click();
    }

    // ---------- Activity ----------
    function runActivityTick() {
        for (const wrapper of queryAll(SELECTORS.activity)) {
            if (queryOne(SELECTORS.cooldown, wrapper)) continue;
            queryOne(SELECTORS.clickable, wrapper)?.click();
        }
    }

    // ---------- Continue ----------
    function tryContinue() {
        const btn = queryOne(SELECTORS.cont);
        if (!btn || state.clickedContinue.has(btn)) return;

        state.clickedContinue.add(btn);
        btn.click();

        console.log("%c[Continue] Clicked", "color:#aaffff;font-weight:bold");
    }

    // ---------- Ranger ----------
    const hitTargets = new WeakSet();

    function fireTarget(el) {
        if (!document.contains(el)) return;

        const btn = queryOne(SELECTORS.clickable, el) || el;
        try {
            btn.focus({ preventScroll: true });
        } catch {}

        btn.click();

        sendKey(btn, " ");
        sendKey(document.body, " ");
    }

    function tryTarget(el) {
        if (hitTargets.has(el)) return;

        try {
            if (!el.matches(SELECTORS.target)) return;
        } catch {
            return;
        }

        hitTargets.add(el);
        setTimeout(() => fireTarget(el), CONFIG.settleMs);
    }

    // ---------- Craft ----------
    function keysEqual(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    function isCraftArrowSuccess(img) {
        const classes = Array.from(img?.classList || []);
        return classes.some((cls) => cls === "arrowSuccess__34527" || cls.startsWith("arrowSuccess__"));
    }

    function getLiveSequenceElement(seqHint) {
        if (seqHint instanceof Element && document.contains(seqHint)) {
            if (seqHint.matches?.(SELECTORS.seq)) return seqHint;

            const closest = seqHint.closest?.(SELECTORS.seq);
            if (closest && document.contains(closest)) return closest;
        }

        return queryOne(SELECTORS.seq);
    }

    function readPendingSequenceKeys(seqHint) {
        const seq = getLiveSequenceElement(seqHint);
        if (!seq) return [];

        return queryAll(SELECTORS.char, seq)
            .filter((img) => !isCraftArrowSuccess(img))
            .map((img) => normalizeKeyName(img.getAttribute("alt")))
            .filter((name) => KEY_MAP[name]);
    }

    async function waitForSequenceChange(beforeKeys, seqHint) {
        const startedAt = performance.now();

        while (performance.now() - startedAt <= CONFIG.craftStepAckTimeoutMs) {
            const nowKeys = readPendingSequenceKeys(seqHint);
            if (!keysEqual(nowKeys, beforeKeys)) {
                return { changed: true, keys: nowKeys };
            }
            await delay(CONFIG.craftStepPollMs);
        }

        return { changed: false, keys: readPendingSequenceKeys(seqHint) };
    }

    function sendCraftKeyEverywhere(key) {
        let targetsDelivered = 0;

        try {
            if (sendKey(document, key) > 0) targetsDelivered++;
        } catch (e) {
            console.warn("%c[Craft] Failed to send to document:", "color:#ffaa00", e.message);
        }

        try {
            if (sendKey(document.body, key) > 0) targetsDelivered++;
        } catch (e) {
            console.warn("%c[Craft] Failed to send to body:", "color:#ffaa00", e.message);
        }

        const active = document.activeElement;
        if (active && active !== document.body && document.contains(active)) {
            try {
                if (sendKey(active, key) > 0) targetsDelivered++;
            } catch (e) {
                console.warn("%c[Craft] Failed to send to activeElement:", "color:#ffaa00", e.message);
            }
        }

        return targetsDelivered;
    }

    async function runCraftAttempt(keys, attempt, seqHint) {
        console.log(
            `%c[Craft] Attempt ${attempt}/${CONFIG.craftRetryWholeMax}:`,
            "color:#66ffcc;font-weight:bold",
            keys.join(" -> ")
        );

        for (let i = 0; i < keys.length; i++) {
            const expectedKey = keys[i];
            const beforeKeys = readPendingSequenceKeys(seqHint);

            if (!beforeKeys.length) {
                return { ok: true, reason: "sequence already resolved" };
            }

            if (beforeKeys[0] !== expectedKey) {
                return {
                    ok: false,
                    reason: `desync before step ${i + 1}: expected ${expectedKey}, got ${beforeKeys[0] || "<none>"}`
                };
            }

            const delivered = sendCraftKeyEverywhere(expectedKey);
            if (delivered === 0) {
                return { ok: false, reason: `no target accepted key ${expectedKey}` };
            }

            await delay(CONFIG.craftPostKeySettleMs);

            const ack = await waitForSequenceChange(beforeKeys, seqHint);
            if (!ack.changed) {
                return {
                    ok: false,
                    reason: `no sequence change after key ${expectedKey}`
                };
            }

            await delay(CONFIG.keyDelayMs);
        }

        return { ok: true, reason: "attempt completed" };
    }

    async function doSequence(seqEl) {
        if (state.craftBusy) return;

        const initialKeys = readPendingSequenceKeys(seqEl);
        if (!initialKeys.length) return;

        const seqKey = initialKeys.join(",");
        const now = Date.now();
        const sameSeqCooldownLeft = CONFIG.craftRetrySameSeqMs - (now - state.lastSeqSentAt);

        if (seqKey === state.lastSeqKey && sameSeqCooldownLeft > 0) return;

        state.craftBusy = true;
        state.lastSeqKey = seqKey;
        state.lastSeqSentAt = now;

        try {
            let solved = false;

            for (let attempt = 1; attempt <= CONFIG.craftRetryWholeMax; attempt++) {
                const keys = readPendingSequenceKeys(seqEl);
                if (!keys.length) {
                    solved = true;
                    break;
                }

                const result = await runCraftAttempt(keys, attempt, seqEl);
                if (result.ok) {
                    solved = true;
                    break;
                }

                console.warn("%c[Craft] Attempt failed:", "color:#ffaa00;font-weight:bold", result.reason);

                if (attempt < CONFIG.craftRetryWholeMax) {
                    await delay(CONFIG.craftRetryBackoffMs);
                }
            }

            if (!solved) {
                console.warn("%c[Craft] Full sequence retries exhausted", "color:#ff6600;font-weight:bold");
                state.lastSeqKey = "";
                state.lastSeqSentAt = 0;
            }
        } finally {
            state.craftBusy = false;
        }
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

            // Learn "alive" sprite while projectile is moving.
            if (src) state.liveProjectileSprites.add(src);
        } else if (dt >= 20) {
            meta.stableFrames += 1;
        }

        const looksLikeImpactSprite =
            meta.moved && !!src && state.liveProjectileSprites.size > 0 && !state.liveProjectileSprites.has(src);
        const frozenAfterMove = meta.moved && meta.stableFrames >= 2;

        // Do not resolve on generic src changes: many flight sprites are animated and swap frames.
        const resolved = looksLikeImpactSprite || frozenAfterMove;

        meta.top = topMetric;
        meta.ts = now;
        meta.src = src || meta.src;

        return resolved;
    }

    function getShieldWidthLogical(shield) {
        return Math.max(
            CONFIG.palMinShieldW,
            toNum(shield.style.width) ?? toNum(getComputedStyle(shield).width) ?? CONFIG.palDefaultShieldW
        );
    }

    function getProjectileThreats(root) {
        const list = [];
        const now = performance.now();

        for (const el of queryAll(SELECTORS.projectile, root)) {
            if (!isVisible(el)) continue;

            const rect = el.getBoundingClientRect();
            const topMetric = toNum(el.style.top) ?? rect.bottom;
            const src = el.getAttribute("src") || "";

            // Skip projectiles already in impact animation.
            if (isResolvedProjectile(el, topMetric, src, now)) continue;

            const leftLogical = toNum(el.style.left);
            const widthLogical = toNum(el.style.width) ?? CONFIG.palDefaultProjW;
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

        const first = threats[0];
        const second = threats[1];

        if (!second) {
            return {
                logicalCenter: first.logicalCenter,
                clientCenter: first.clientCenter
            };
        }

        const closeInY = first.topMetric - second.topMetric <= CONFIG.palTopDelta;

        if (
            closeInY &&
            first.logicalCenter !== null &&
            second.logicalCenter !== null &&
            Math.abs(first.logicalCenter - second.logicalCenter) <= shieldW * CONFIG.palDualCoverRatio
        ) {
            // Dual-threat mode: check if 3+ close projectiles should be included
            let avgLogical = first.logicalCenter + second.logicalCenter;
            let avgClient = first.clientCenter + second.clientCenter;
            let count = 2;

            // Include nearby threats beyond the second one
            for (let i = 2; i < threats.length; i++) {
                const threat = threats[i];
                if (first.topMetric - threat.topMetric > CONFIG.palTopDelta) break; // Too far down
                if (threat.logicalCenter === null) continue;
                if (Math.abs(first.logicalCenter - threat.logicalCenter) > shieldW * CONFIG.palDualCoverRatio) continue;
                
                avgLogical += threat.logicalCenter;
                avgClient += threat.clientCenter;
                count++;
            }

            return {
                logicalCenter: avgLogical / count,
                clientCenter: avgClient / count
            };
        }

        return {
            logicalCenter: first.logicalCenter,
            clientCenter: first.clientCenter
        };
    }

    function getPaladinInputTargets(ctx) {
        return [ctx.shield, ctx.root, document, document.body, window];
    }

    function paladinPointerDown(ctx, x, y) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        const mouse = { ...base, button: 0, buttons: 1 };
        const pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const target of getPaladinInputTargets(ctx)) {
            emitPointer(target, "pointerdown", pointer);
            emitMouse(target, "mousedown", mouse);
        }

        state.palDrag = true;
    }

    function paladinPointerMove(ctx, x, y) {
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: 1 };
        const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const target of getPaladinInputTargets(ctx)) {
            emitPointer(target, "pointermove", pointer);
            emitMouse(target, "mousemove", base);
        }
    }

    function paladinPointerUp() {
        if (!state.palDrag) return;

        const root = state.palRoot;
        const rect = root?.getBoundingClientRect();

        const x = rect ? rect.left + rect.width / 2 : 0;
        const y = rect ? rect.top + rect.height * CONFIG.palAimY : 0;

        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        const mouse = { ...base, button: 0, buttons: 0 };
        const pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true };

        for (const target of [root, document, document.body, window]) {
            emitPointer(target, "pointerup", pointer);
            emitMouse(target, "mouseup", mouse);
        }

        state.palDrag = false;
    }

    function mouseEventInsidePaladin(e) {
        const root = state.palRoot;
        if (!root) return true;
        if (!("clientX" in e) || !("clientY" in e)) return true;

        const rect = root.getBoundingClientRect();
        return (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
        );
    }

    function enableMouseLock() {
        if (!CONFIG.blockRealMouse || state.mouseLockHandler) return;

        state.mouseLockHandler = (e) => {
            if (state.mode !== "paladin") return;
            if (!e.isTrusted) return;
            if (!mouseEventInsidePaladin(e)) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };

        for (const ev of MOUSE_LOCK_EVENTS) {
            window.addEventListener(ev, state.mouseLockHandler, true);
            document.addEventListener(ev, state.mouseLockHandler, true);
        }
    }

    function disableMouseLock() {
        if (!state.mouseLockHandler) return;

        for (const ev of MOUSE_LOCK_EVENTS) {
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
            const currentLeft = toNum(ctx.shield.style.left);
            const desiredLeft = target.logicalCenter - shieldW / 2;
            const nextLeft =
                currentLeft === null ? desiredLeft : currentLeft + (desiredLeft - currentLeft) * CONFIG.palSmooth;

            ctx.shield.style.setProperty("left", `${nextLeft}px`, "important");
            ctx.shield.style.setProperty("transform", "none", "important");
        }

        // Guard against null clientCenter
        if (target.clientCenter === null || target.clientCenter === undefined) {
            return;
        }

        const x = target.clientCenter;
        const y = ctx.rect.top + ctx.rect.height * CONFIG.palAimY;

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
        const glyphRoot =
            queryOne(SELECTORS.priestGlyph, tile) || queryOne(".gridAssetFront__0dcd3 svg", tile) || queryOne("svg", tile);
        if (!glyphRoot) return null;

        const paths = queryAll("path", glyphRoot)
            .map((p) => p.getAttribute("d") || "")
            .join("|");
        if (paths && paths.length > 12) return paths;

        const html = (glyphRoot.innerHTML || "").replace(/\s+/g, "");
        return html || null;
    }

    function buildPriestGroups() {
        const items = queryAll(SELECTORS.priestItem).filter(
            (el) => isVisible(el) && !el.classList.contains(PRIEST_MATCHED_CLASS)
        );

        const groupsBySignature = new Map();

        for (const item of items) {
            const signature = getPriestGlyphSignature(item);
            if (!signature) continue;

            if (!groupsBySignature.has(signature)) groupsBySignature.set(signature, []);
            groupsBySignature.get(signature).push(item);
        }

        return Array.from(groupsBySignature.values())
            .filter((group) => group.length >= 3)
            .map((group) => group.slice(0, 3));
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
                    await delay(CONFIG.priestClickDelayMs);
                }

                await delay(CONFIG.priestTripletDelayMs);
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
    function handleAddedNode(node) {
        if (!(node instanceof Element)) return;

        if (node.matches?.(SELECTORS.target)) tryTarget(node);
        node.querySelectorAll?.(SELECTORS.target).forEach(tryTarget);

        const seq = node.matches?.(SELECTORS.seq) ? node : node.querySelector?.(SELECTORS.seq);
        if (seq) doSequence(seq);

        if (node.matches?.(SELECTORS.cont) || node.querySelector?.(SELECTORS.cont)) tryContinue();

        // Fast reaction Paladin.
        if (state.mode === "paladin") {
            if (node.matches?.(SELECTORS.projectile) || node.querySelector?.(SELECTORS.projectile)) {
                paladinTick();
            }
        }

        // Fast reaction Priest.
        if (state.mode === "priest") {
            if (
                node.matches?.(SELECTORS.priestItem) ||
                node.matches?.(SELECTORS.priestGrid) ||
                node.querySelector?.(SELECTORS.priestItem)
            ) {
                priestTick();
            }
        }
    }

    function handleMutation(mutation) {
        for (const node of mutation.addedNodes) {
            handleAddedNode(node);
        }

        if (mutation.type === "childList" && mutation.target instanceof Element) {
            if (mutation.target.closest?.(SELECTORS.seq) || mutation.target.matches?.(SELECTORS.seq)) {
                doSequence(mutation.target.closest(SELECTORS.seq) || mutation.target);
            }
        }
    }

    state.observer = new MutationObserver((mutations) => {
        tryClickGoBackModal();
        checkBattleMode();

        for (const mutation of mutations) {
            handleMutation(mutation);
        }
    });

    // ---------- Poll ----------
    function runPollTick() {
        tryClickGoBackModal();
        checkBattleMode();

        queryAll(SELECTORS.target).forEach(tryTarget);

        const seq = queryOne(SELECTORS.seq);
        if (seq) doSequence(seq);
        else {
            state.lastSeqKey = "";
            state.lastSeqSentAt = 0;
        }

        if (state.mode === "priest") priestTick();

        tryContinue();
    }

    // ---------- Stop ----------
    window.stopBot = () => {
        clearInterval(state.dragonTimer);
        clearInterval(state.activityTimer);
        clearInterval(state.goBackTimer);
        clearInterval(state.pollTimer);

        stopPaladinBot();
        stopPriestBot();

        if (state.observer) {
            state.observer.disconnect();
            state.observer = null;
        }

        console.log("%c[BOT] Stopped", "color:red;font-weight:bold");
    };

    // ---------- Init ----------
    state.dragonTimer = setInterval(runDragonTick, CONFIG.dragonMs);
    state.activityTimer = setInterval(runActivityTick, CONFIG.activityMs);
    state.goBackTimer = setInterval(tryClickGoBackModal, CONFIG.goBackScanMs);
    state.pollTimer = setInterval(runPollTick, CONFIG.pollMs);

    state.observer.observe(document.body, { childList: true, subtree: true });

    checkBattleMode();

    const initSeq = queryOne(SELECTORS.seq);
    if (initSeq) doSequence(initSeq);

    tryClickGoBackModal();
    tryContinue();

    console.log("%c[The Last Meadow Auto Script] v2.0 Tampermonkey Edition", "color:#00ff00;font-weight:bold;font-size:14px");
    console.log("%cStop command: stopBot()", "color:#ff9900");
})();
