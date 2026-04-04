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
    "use strict";

    // Stop previous instance if it exists
    try {
        if (typeof window.stopBot === "function") window.stopBot();
    } catch {}

    const MODE = Object.freeze({
        IDLE: null,
        RANGER: "ranger",
        PALADIN: "paladin",
        PRIEST: "priest"
    });

    const HASH = {
        RANGER: "16fb25536f00a7996cbdf5bfff2ef0d09459f580af9e67d380263f5ead43055e"
    };

    const SELECTOR = {
        // Shared
        clickable: ".clickable__5c90e",
        activityButton: ".activityButton__8af73",
        activityCooldown: ".countdown__8af73",
        continueButton: ".continueButtonWrapper__24749 .clickable__5c90e",
        modalResourceText: ".text_a2a25a, .text-lg\\/normal_cf4812, [data-text-variant='text-lg/normal']",
        goBackButton: ".button__65fca.buttonWhite__65fca.clickable__5c90e",

        // Ranger
        rangerTarget: ".targetContainer_b6b008",

        // Craft
        craftSequences: ".sequences__34527",
        craftCharacter: ".character__34527 img[alt]",

        // Paladin
        paladinRoot: ".container__24749, .game__24749, .shaker_cce732",
        paladinShield: ".shield_cce732",
        paladinProjectile: ".projectile_cce732",

        // Priest
        priestGame: ".game__5c62c",
        priestGrid: ".grid__0dcd3",
        priestItem: ".gridItem__0dcd3",
        priestMatched: ".matched__0dcd3",
        priestGlyph: ".gridAssetGlyph__0dcd3"
    };

    const CONFIG = {
        // Base loops
        dragonClickIntervalMs: 50,
        activityClickIntervalMs: 50,
        pollIntervalMs: 25,
        modalScanIntervalMs: 60,

        // Craft
        craftSettleMs: 20,
        craftKeyDelayMs: 70,
        craftRetryCooldownMs: 180,

        // Paladin base
        paladinSmoothing: 0.42,
        paladinAimYRatio: 0.93,
        paladinSecondThreatDeltaY: 95,
        paladinDualCoverRatio: 0.9,
        paladinDefaultShieldWidth: 138,
        paladinDefaultProjectileWidth: 115,
        paladinMinShieldWidth: 96,
        paladinMouseLock: true,

        // Paladin anti-jitter
        paladinMinSwitchIntervalMs: 70,
        paladinSwitchPriorityDelta: 34,
        paladinDeadZonePx: 2.5,
        paladinPointerSmoothing: 0.6,
        paladinPointerDeadZonePx: 1.5,

        // Priest
        priestClickDelayMs: 28,
        priestTripletDelayMs: 120,

        // Modal
        modalClickCooldownMs: 250
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

    const runtime = {
        mode: MODE.IDLE,
        observer: null,
        intervalIds: new Set()
    };

    const q = (selector, root = document) => root.querySelector(selector);
    const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    const toNumber = (value) => {
        const n = parseFloat(value);
        return Number.isFinite(n) ? n : null;
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const log = (message, color = "#88ccff") => {
        console.log(`%c${message}`, `color:${color};font-weight:bold`);
    };

    function isVisible(element) {
        if (!(element instanceof Element)) return false;
        if (!document.contains(element)) return false;

        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;

        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;

        const opacity = parseFloat(style.opacity || "1");
        if (Number.isFinite(opacity) && opacity < 0.02) return false;

        return true;
    }

    function normalizeKeyName(keyName) {
        if (!keyName) return null;
        const normalized = String(keyName).trim();
        if (normalized === "Space" || normalized === "Spacebar") return " ";
        return normalized;
    }

    function sendKey(target, keyName) {
        if (!target) return;

        const normalized = normalizeKeyName(keyName);
        const definition = KEY_MAP[normalized];
        if (!definition) return;

        const options = { bubbles: true, cancelable: true, ...definition };
        try {
            target.dispatchEvent(new KeyboardEvent("keydown", options));
            target.dispatchEvent(new KeyboardEvent("keypress", options));
            target.dispatchEvent(new KeyboardEvent("keyup", options));
        } catch {}
    }

    function emitPointer(target, type, options) {
        if (!target || typeof target.dispatchEvent !== "function") return;
        if (typeof PointerEvent !== "function") return;
        try {
            target.dispatchEvent(new PointerEvent(type, options));
        } catch {}
    }

    function emitMouse(target, type, options) {
        if (!target || typeof target.dispatchEvent !== "function") return;
        try {
            target.dispatchEvent(new MouseEvent(type, options));
        } catch {}
    }

    function hardClick(element) {
        if (!element) return false;

        try {
            if (typeof element.focus === "function") element.focus({ preventScroll: true });
        } catch {}

        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;

        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;

        const underCursor = document.elementFromPoint(clientX, clientY);
        const targets = [element, underCursor].filter(Boolean);

        const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY };
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
            element.click();
        } catch {}

        try {
            element.dispatchEvent(new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            }));
            element.dispatchEvent(new KeyboardEvent("keyup", {
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

    function addInterval(callback, intervalMs) {
        const id = setInterval(callback, intervalMs);
        runtime.intervalIds.add(id);
        return id;
    }

    function clearAllIntervals() {
        for (const id of runtime.intervalIds) clearInterval(id);
        runtime.intervalIds.clear();
    }

    const modalManager = (() => {
        let lastClickAt = 0;

        function tick() {
            const now = Date.now();
            if (now - lastClickAt < CONFIG.modalClickCooldownMs) return false;

            const warningNode = qa(SELECTOR.modalResourceText).find((element) => {
                if (!isVisible(element)) return false;
                return OUT_OF_RESOURCES_RE.test((element.textContent || "").trim());
            });

            if (!warningNode) return false;

            const modalRoot =
                warningNode.closest("[role='dialog']") ||
                warningNode.closest("[class*='modal']") ||
                warningNode.closest("[class*='layer']") ||
                warningNode.parentElement ||
                document;

            let button = q(SELECTOR.goBackButton, modalRoot);
            if (button && !isVisible(button)) button = null;

            if (!button) {
                button = qa(SELECTOR.goBackButton).find((b) => isVisible(b)) || null;
            }

            if (!button) return false;

            lastClickAt = now;
            hardClick(button);
            setTimeout(() => hardClick(button), 60);

            log("[Modal] Go Back clicked", "#ffcc66");
            return true;
        }

        return { tick };
    })();

    const continueManager = (() => {
        const clickedButtons = new WeakSet();

        function tick() {
            const button = q(SELECTOR.continueButton);
            if (!button || clickedButtons.has(button)) return;

            clickedButtons.add(button);
            button.click();
            log("[Continue] Clicked", "#aaffff");
        }

        return { tick };
    })();

    const rangerManager = (() => {
        const processedTargets = new WeakSet();

        function fireTarget(targetRoot) {
            if (!document.contains(targetRoot)) return;

            const clickable = q(SELECTOR.clickable, targetRoot) || targetRoot;
            clickable.focus({ preventScroll: true });
            clickable.click();

            sendKey(clickable, " ");
            sendKey(document.body, " ");
        }

        function queueTarget(targetElement) {
            if (processedTargets.has(targetElement)) return;

            try {
                if (!targetElement.matches(SELECTOR.rangerTarget)) return;
            } catch {
                return;
            }

            processedTargets.add(targetElement);
            setTimeout(() => fireTarget(targetElement), CONFIG.craftSettleMs);
        }

        function tick() {
            qa(SELECTOR.rangerTarget).forEach(queueTarget);
        }

        function onNodeAdded(node) {
            if (!(node instanceof Element)) return;
            if (node.matches?.(SELECTOR.rangerTarget)) queueTarget(node);
            node.querySelectorAll?.(SELECTOR.rangerTarget).forEach(queueTarget);
        }

        return { tick, onNodeAdded };
    })();

    const craftManager = (() => {
        let busy = false;
        let lastAttemptAt = 0;

        async function runSequence(sequenceElement) {
            const keys = qa(SELECTOR.craftCharacter, sequenceElement)
                .map((img) => normalizeKeyName(img.getAttribute("alt")))
                .filter((key) => KEY_MAP[key]);

            if (!keys.length || busy) return;

            const now = Date.now();
            if (now - lastAttemptAt < CONFIG.craftRetryCooldownMs) return;

            busy = true;
            lastAttemptAt = now;

            log(`[Craft] Sequence: ${keys.join(" -> ")}`, "#ffff00");

            try {
                for (const key of keys) {
                    sendKey(document, key);
                    sendKey(document.body, key);
                    sendKey(window, key);

                    const active = document.activeElement;
                    if (active && active !== document.body) sendKey(active, key);

                    await sleep(CONFIG.craftKeyDelayMs);
                }
            } finally {
                busy = false;
            }
        }

        function tick(sequenceOverride) {
            const sequenceElement = sequenceOverride || q(SELECTOR.craftSequences);
            if (!sequenceElement) return;
            runSequence(sequenceElement);
        }

        function onNodeAdded(node) {
            if (!(node instanceof Element)) return;

            const sequenceElement = node.matches?.(SELECTOR.craftSequences)
                ? node
                : node.querySelector?.(SELECTOR.craftSequences);

            if (sequenceElement) tick(sequenceElement);
        }

        return { tick, onNodeAdded };
    })();

    const paladinManager = (() => {
        let rafId = 0;
        let dragActive = false;
        let arenaRoot = null;
        let mouseLockHandler = null;

        let projectileMeta = new WeakMap();
        let liveProjectileSprites = new Set();

        let trackedProjectile = null;
        let lastSwitchAt = 0;
        let lastClientX = null;

        function resetProjectileCache() {
            projectileMeta = new WeakMap();
            liveProjectileSprites = new Set();

            trackedProjectile = null;
            lastSwitchAt = 0;
            lastClientX = null;
        }

        function getContext() {
            let best = null;

            for (const root of qa(SELECTOR.paladinRoot)) {
                if (!isVisible(root)) continue;

                const shield = q(SELECTOR.paladinShield, root);
                if (!shield || !isVisible(shield)) continue;

                const rect = root.getBoundingClientRect();
                if (rect.width < 80 || rect.height < 80) continue;

                const projectiles = qa(SELECTOR.paladinProjectile, root).filter(isVisible);
                const score = projectiles.length * 1000000 + rect.width * rect.height;

                if (!best || score > best.score) {
                    best = { root, shield, rect, projectiles };
                }
            }

            return best;
        }

        function isResolvedProjectile(projectile, topMetric, src, now) {
            let previous = projectileMeta.get(projectile);

            if (!previous) {
                previous = {
                    top: topMetric,
                    ts: now,
                    stableFrames: 0,
                    moved: false,
                    src: src || ""
                };
                projectileMeta.set(projectile, previous);
                return false;
            }

            const dy = Math.abs(topMetric - previous.top);
            const dt = now - previous.ts;

            if (dy > 0.7) {
                previous.moved = true;
                previous.stableFrames = 0;
                if (src) liveProjectileSprites.add(src);
            } else if (dt >= 20) {
                previous.stableFrames += 1;
            }

            const srcChanged = Boolean(previous.src && src && previous.src !== src);

            const switchedToUnknownSprite =
                previous.moved &&
                Boolean(src) &&
                liveProjectileSprites.size > 0 &&
                !liveProjectileSprites.has(src);

            const frozenAfterMovement = previous.moved && previous.stableFrames >= 2;

            const resolved =
                switchedToUnknownSprite ||
                (srcChanged && previous.moved) ||
                frozenAfterMovement;

            previous.top = topMetric;
            previous.ts = now;
            previous.src = src || previous.src;

            return resolved;
        }

        function getThreats(root) {
            const threats = [];
            const now = performance.now();

            for (const projectile of qa(SELECTOR.paladinProjectile, root)) {
                if (!isVisible(projectile)) continue;

                const rect = projectile.getBoundingClientRect();
                const topMetric = toNumber(projectile.style.top) ?? rect.bottom;
                const src = projectile.getAttribute("src") || "";

                // Skip projectile already in post-collision animation
                if (isResolvedProjectile(projectile, topMetric, src, now)) continue;

                const leftLogical = toNumber(projectile.style.left);
                const widthLogical = toNumber(projectile.style.width) ?? CONFIG.paladinDefaultProjectileWidth;
                const logicalCenter = leftLogical == null ? null : leftLogical + widthLogical / 2;
                const clientCenter = rect.left + rect.width / 2;

                threats.push({
                    element: projectile,
                    topMetric,
                    logicalCenter,
                    clientCenter
                });
            }

            threats.sort((a, b) => b.topMetric - a.topMetric);
            return threats;
        }

        function getShieldWidth(shield) {
            return Math.max(
                CONFIG.paladinMinShieldWidth,
                toNumber(shield.style.width) ??
                    toNumber(getComputedStyle(shield).width) ??
                    CONFIG.paladinDefaultShieldWidth
            );
        }

        function chooseTarget(threats, shieldWidth) {
            if (!threats.length) return null;

            const now = performance.now();
            const leader = threats[0];
            let selected = leader;

            if (trackedProjectile) {
                const tracked = threats.find((t) => t.element === trackedProjectile);

                if (tracked) {
                    const canSwitchByTime =
                        (now - lastSwitchAt) >= CONFIG.paladinMinSwitchIntervalMs;

                    const leaderMuchCloser =
                        leader.element !== tracked.element &&
                        (leader.topMetric - tracked.topMetric) >= CONFIG.paladinSwitchPriorityDelta;

                    selected = (canSwitchByTime && leaderMuchCloser) ? leader : tracked;
                }
            }

            if (selected.element !== trackedProjectile) {
                trackedProjectile = selected.element;
                lastSwitchAt = now;
            }

            const second = threats.find((t) => t.element !== selected.element);

            if (
                second &&
                selected.logicalCenter != null &&
                second.logicalCenter != null &&
                (selected.topMetric - second.topMetric) <= CONFIG.paladinSecondThreatDeltaY &&
                Math.abs(selected.logicalCenter - second.logicalCenter) <= shieldWidth * CONFIG.paladinDualCoverRatio
            ) {
                return {
                    logicalCenter: (selected.logicalCenter + second.logicalCenter) / 2,
                    clientCenter: (selected.clientCenter + second.clientCenter) / 2
                };
            }

            return {
                logicalCenter: selected.logicalCenter,
                clientCenter: selected.clientCenter
            };
        }

        function getInputTargets(context) {
            return [context.shield, context.root, document, document.body, window];
        }

        function pointerDown(context, x, y) {
            const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
            const mouse = { ...base, button: 0, buttons: 1 };
            const pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true };

            for (const target of getInputTargets(context)) {
                emitPointer(target, "pointerdown", pointer);
                emitMouse(target, "mousedown", mouse);
            }

            dragActive = true;
        }

        function pointerMove(context, x, y) {
            const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, buttons: 1 };
            const pointer = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };

            for (const target of getInputTargets(context)) {
                emitPointer(target, "pointermove", pointer);
                emitMouse(target, "mousemove", base);
            }
        }

        function pointerUp() {
            if (!dragActive) return;

            const rect = arenaRoot?.getBoundingClientRect();
            const x = rect ? rect.left + rect.width / 2 : 0;
            const y = rect ? rect.top + rect.height * CONFIG.paladinAimYRatio : 0;

            const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
            const mouse = { ...base, button: 0, buttons: 0 };
            const pointer = { ...mouse, pointerId: 1, pointerType: "mouse", isPrimary: true };

            for (const target of [arenaRoot, document, document.body, window]) {
                emitPointer(target, "pointerup", pointer);
                emitMouse(target, "mouseup", mouse);
            }

            dragActive = false;
        }

        function eventInsideArena(event) {
            if (!arenaRoot) return true;
            if (!("clientX" in event) || !("clientY" in event)) return true;

            const rect = arenaRoot.getBoundingClientRect();
            return (
                event.clientX >= rect.left &&
                event.clientX <= rect.right &&
                event.clientY >= rect.top &&
                event.clientY <= rect.bottom
            );
        }

        function enableMouseLock() {
            if (!CONFIG.paladinMouseLock || mouseLockHandler) return;

            mouseLockHandler = (event) => {
                if (runtime.mode !== MODE.PALADIN) return;
                if (!event.isTrusted) return;
                if (!eventInsideArena(event)) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            };

            const events = [
                "pointermove",
                "mousemove",
                "dragstart",
                "pointerdown",
                "mousedown",
                "pointerup",
                "mouseup"
            ];

            for (const eventName of events) {
                window.addEventListener(eventName, mouseLockHandler, true);
                document.addEventListener(eventName, mouseLockHandler, true);
            }
        }

        function disableMouseLock() {
            if (!mouseLockHandler) return;

            const events = [
                "pointermove",
                "mousemove",
                "dragstart",
                "pointerdown",
                "mousedown",
                "pointerup",
                "mouseup"
            ];

            for (const eventName of events) {
                window.removeEventListener(eventName, mouseLockHandler, true);
                document.removeEventListener(eventName, mouseLockHandler, true);
            }

            mouseLockHandler = null;
        }

        function tick() {
            const context = getContext();
            if (!context) return;

            arenaRoot = context.root;

            const threats = getThreats(context.root);
            if (!threats.length) return;

            const shieldWidth = getShieldWidth(context.shield);
            const target = chooseTarget(threats, shieldWidth);
            if (!target) return;

            // Direct position update with dead-zone to prevent tiny oscillations
            if (target.logicalCenter != null) {
                const currentLeft = toNumber(context.shield.style.left);
                const desiredLeft = target.logicalCenter - shieldWidth / 2;
                const baseLeft = currentLeft == null ? desiredLeft : currentLeft;
                const delta = desiredLeft - baseLeft;

                if (Math.abs(delta) >= CONFIG.paladinDeadZonePx) {
                    const nextLeft = baseLeft + delta * CONFIG.paladinSmoothing;
                    context.shield.style.setProperty("left", `${nextLeft}px`, "important");
                    context.shield.style.setProperty("transform", "none", "important");
                }
            }

            // Pointer smoothing with dead-zone to reduce jitter
            let x = target.clientCenter;
            if (lastClientX == null) lastClientX = x;

            const dx = x - lastClientX;
            if (Math.abs(dx) < CONFIG.paladinPointerDeadZonePx) {
                x = lastClientX;
            } else {
                x = lastClientX + dx * CONFIG.paladinPointerSmoothing;
            }
            lastClientX = x;

            const y = context.rect.top + context.rect.height * CONFIG.paladinAimYRatio;

            if (!dragActive) pointerDown(context, x, y);
            pointerMove(context, x, y);
        }

        function frame() {
            tick();
            rafId = requestAnimationFrame(frame);
        }

        function start() {
            if (rafId) return;

            resetProjectileCache();
            enableMouseLock();
            rafId = requestAnimationFrame(frame);
            log("[Paladin] Bot started", "#88aaff");
        }

        function stop() {
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }

            pointerUp();
            disableMouseLock();
            arenaRoot = null;
            resetProjectileCache();
        }

        function onNodeAdded(node) {
            if (runtime.mode !== MODE.PALADIN || !(node instanceof Element)) return;
            if (node.matches?.(SELECTOR.paladinProjectile) || node.querySelector?.(SELECTOR.paladinProjectile)) {
                tick();
            }
        }

        return {
            getContext,
            tick,
            start,
            stop,
            onNodeAdded
        };
    })();

    const priestManager = (() => {
        let rafId = 0;
        let busy = false;

        function hasBoard() {
            const board = q(SELECTOR.priestGrid) || q(SELECTOR.priestGame);
            if (!board) return false;
            const items = qa(SELECTOR.priestItem).filter(isVisible);
            return items.length >= 3;
        }

        function getGlyphSignature(tile) {
            const glyphRoot =
                q(SELECTOR.priestGlyph, tile) ||
                q(".gridAssetFront__0dcd3 svg", tile) ||
                q("svg", tile);

            if (!glyphRoot) return null;

            const paths = qa("path", glyphRoot).map((p) => p.getAttribute("d") || "").join("|");
            if (paths && paths.length > 12) return paths;

            const html = (glyphRoot.innerHTML || "").replace(/\s+/g, "");
            return html || null;
        }

        function buildGroups() {
            const tiles = qa(SELECTOR.priestItem).filter(
                (tile) => isVisible(tile) && !tile.classList.contains(PRIEST_MATCHED_CLASS)
            );

            const groupsBySignature = new Map();

            for (const tile of tiles) {
                const signature = getGlyphSignature(tile);
                if (!signature) continue;

                if (!groupsBySignature.has(signature)) groupsBySignature.set(signature, []);
                groupsBySignature.get(signature).push(tile);
            }

            return Array.from(groupsBySignature.values())
                .filter((group) => group.length >= 3)
                .map((group) => group.slice(0, 3));
        }

        async function solveOnce() {
            if (busy || runtime.mode !== MODE.PRIEST) return;
            busy = true;

            try {
                const groups = buildGroups();
                if (!groups.length) return;

                for (const group of groups) {
                    if (runtime.mode !== MODE.PRIEST) break;

                    const liveTiles = group.filter(
                        (tile) =>
                            document.contains(tile) &&
                            isVisible(tile) &&
                            !tile.classList.contains(PRIEST_MATCHED_CLASS)
                    );

                    if (liveTiles.length < 3) continue;

                    for (const tile of liveTiles) {
                        if (runtime.mode !== MODE.PRIEST) break;
                        hardClick(tile);
                        await sleep(CONFIG.priestClickDelayMs);
                    }

                    await sleep(CONFIG.priestTripletDelayMs);
                }
            } finally {
                busy = false;
            }
        }

        function tick() {
            if (runtime.mode !== MODE.PRIEST) return;
            if (!hasBoard()) return;
            solveOnce();
        }

        function frame() {
            tick();
            rafId = requestAnimationFrame(frame);
        }

        function start() {
            if (rafId) return;
            busy = false;
            rafId = requestAnimationFrame(frame);
            log("[Priest] Bot started", "#a3ffcc");
        }

        function stop() {
            if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = 0;
            }
            busy = false;
        }

        function onNodeAdded(node) {
            if (runtime.mode !== MODE.PRIEST || !(node instanceof Element)) return;

            if (
                node.matches?.(SELECTOR.priestItem) ||
                node.matches?.(SELECTOR.priestGrid) ||
                node.querySelector?.(SELECTOR.priestItem)
            ) {
                tick();
            }
        }

        return {
            hasBoard,
            tick,
            start,
            stop,
            onNodeAdded
        };
    })();

    function detectBattleMode() {
        if (paladinManager.getContext()) return MODE.PALADIN;
        if (priestManager.hasBoard()) return MODE.PRIEST;
        if (qa(SELECTOR.rangerTarget).some(isVisible)) return MODE.RANGER;

        // Fallback Ranger detection via activity asset
        for (const wrapper of qa(SELECTOR.activityButton)) {
            const img = wrapper.querySelector("img.activityButtonAsset__8af73, img.asset__65fca");
            if (img && img.src && img.src.includes(HASH.RANGER)) return MODE.RANGER;
        }

        return MODE.IDLE;
    }

    function applyMode(nextMode) {
        if (nextMode === runtime.mode) return;
        runtime.mode = nextMode;

        if (nextMode === MODE.PALADIN) {
            priestManager.stop();
            paladinManager.start();
            log("[Battle] PALADIN mode", "#88aaff");
            return;
        }

        if (nextMode === MODE.PRIEST) {
            paladinManager.stop();
            priestManager.start();
            log("[Battle] PRIEST mode", "#a3ffcc");
            return;
        }

        paladinManager.stop();
        priestManager.stop();

        if (nextMode === MODE.RANGER) {
            log("[Battle] RANGER mode", "#00ff88");
        }
    }

    function handleAddedNode(node) {
        if (!(node instanceof Element)) return;

        rangerManager.onNodeAdded(node);
        craftManager.onNodeAdded(node);
        paladinManager.onNodeAdded(node);
        priestManager.onNodeAdded(node);

        if (node.matches?.(SELECTOR.continueButton) || node.querySelector?.(SELECTOR.continueButton)) {
            continueManager.tick();
        }
    }

    function setupObserver() {
        const observer = new MutationObserver((mutations) => {
            modalManager.tick();
            applyMode(detectBattleMode());

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    handleAddedNode(node);
                }

                if (mutation.type === "childList" && mutation.target instanceof Element) {
                    if (mutation.target.closest?.(SELECTOR.craftSequences) || mutation.target.matches?.(SELECTOR.craftSequences)) {
                        craftManager.tick();
                    }
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
        runtime.observer = observer;
    }

    function pollTick() {
        modalManager.tick();
        applyMode(detectBattleMode());

        rangerManager.tick();
        craftManager.tick();

        if (runtime.mode === MODE.PRIEST) {
            priestManager.tick();
        }

        continueManager.tick();
    }

    function stopAll() {
        clearAllIntervals();

        if (runtime.observer) {
            runtime.observer.disconnect();
            runtime.observer = null;
        }

        paladinManager.stop();
        priestManager.stop();

        log("[BOT] Stopped", "red");
    }

    // Public stop API
    window.stopBot = stopAll;

    // Interval setup
    addInterval(() => {
        const grassToucher = q(".dragonClickable__8e80e") || q('img[alt="Grass Toucher"]');
        if (grassToucher) grassToucher.click();
    }, CONFIG.dragonClickIntervalMs);

    addInterval(() => {
        for (const wrapper of qa(SELECTOR.activityButton)) {
            if (q(SELECTOR.activityCooldown, wrapper)) continue;
            q(SELECTOR.clickable, wrapper)?.click();
        }
    }, CONFIG.activityClickIntervalMs);

    addInterval(() => modalManager.tick(), CONFIG.modalScanIntervalMs);
    addInterval(() => pollTick(), CONFIG.pollIntervalMs);

    setupObserver();

    // Initial pass
    pollTick();
    continueManager.tick();
    modalManager.tick();

    log("[The Last Meadow Auto Script] v2.0", "#00ff00");
    log("Stop command: stopBot()", "#ff9900");
})();
  ```
  
</details>

## Stop the Script

Run this in Console:

```js
stopBot();
```

## Notes

- The script relies on current Discord CSS class names.
- If Discord updates class names, selectors may need to be updated.
- Re-run the script after a page refresh or Discord update.

## Known issues

- None

## Disclaimer

Use at your own risk. This project is for educational and personal automation purposes.
