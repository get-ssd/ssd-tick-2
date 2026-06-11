// analyser/analyser.js
// Heavyweight verbose diagnostic twin of the SSD Tick verifier. Runs the full
// real pipeline (both extraction strategies, per-stage canon logging, Ed25519
// verify, MISMATCH/INVALID discrimination) for every signed post it sees.
//
// Gated behind CFG.analyser — production behaviour is unchanged when false.
// Called fire-and-forget from platform bootstraps after badge.update().
//
// Depends on: tokenParser, canon, keyring, vault, verifier, analyserPanel,
// analyserSearcher, CFG (all loaded before this by manifest).

const analyser = (() => {

  // Per-token process counter. Detects Tick re-fires from platform re-renders/
  // virtualisation — the same token should be processed once; process #N > 1
  // means Tick fired on the same node again. The counter is per page load.
  const _processCount = new Map();
  function _nextProcess(tokenRaw) {
    const n = (_processCount.get(tokenRaw) || 0) + 1;
    _processCount.set(tokenRaw, n);
    return n;
  }

  // ── logging ──────────────────────────────────────────────────────────────────

  function _log(entry) {
    const stamped = { ts: Date.now(), url: location.href, ...entry };
    if (typeof analyserPanel !== 'undefined') analyserPanel.appendLine(_fmt(stamped));
    _ship(stamped);
  }

  function _fmt(e) {
    switch (e.type) {
      case 'start':
        return '\n── token ' + e.hash8 + ' process #' + e.processN + ' [' + e.platform + '] ──';
      case 'a-stage':
        return '  A  ' + e.stage.padEnd(28) + ' ' + String(e.byteLen).padStart(6) + 'b  ' + e.preview;
      case 'a-done':
        return '  A  result  content8=' + e.content8 +
               '  token=' + (e.tokenContent8 || '(none)') + '  match=' + e.match;
      case 'raw-text-info':
        return '  RAW  ' + e.byteLen + 'b  start="' + e.start + '"  tail="' + e.tail + '"';
      case 'b-skip':   return '  B  (skip: ' + e.reason + ')';
      case 'b-done':
        return '  B  ' + e.outcome +
               (e.winner ? '  winner=d' + e.winner.depth + ' s' + e.winner.suffixCount +
                ' ' + e.winner.variantId : '  winner=none') +
               '  cache=' + e.cacheUsed + '  attempts=' + e.attemptCount;
      case 'b-winner-text':
        return '  B    winner-text  ' + e.byteLen + 'b  "' + e.start + '"';
      case 'b-attempt':
        return '  B    d' + e.depth + ' s' + e.suffixCount + ' ' + e.variantId +
               '  c8=' + e.computedContent8 + '  match=' + e.c8Match;
      case 'key':
        return '  KEY  ' + e.path + '  ' +
               (e.resolved ? (e.keyHash8 + ' (' + (e.name || '?') + ')') : 'NOT FOUND');
      case 'sig-fetch': return '  SIG-FETCH vault  ' + (e.success ? 'ok' : 'FAIL');
      case 'ed25519':
        return '  ED25519  [' + e.strategy + ']  ' + (e.valid ? 'PASS' : 'FAIL') +
               (e.error ? '  err=' + e.error : '') + (e.reason ? '  reason=' + e.reason : '');
      case 'disc':       return '  DISC  path=' + e.discPath + '  verdict=' + e.verdict;
      case 'disc-detail': return '  DISC    ' + e.detail;
      case 'truncated':
        return '  TRUNCATED  preTokenLen=' + e.preTokenLen + ' < threshold=' + e.threshold;
      case 'outcome':
        return '  OUTCOME  plugin=' + e.pluginState + '  analyser=' + e.state +
               '  ' + (e.pluginState === e.state ? 'MATCH' : '*** DIVERGE ***');
      default: return '  ' + JSON.stringify(e);
    }
  }

  function _ship(entry) {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    chrome.runtime.sendMessage({
      type:         'analyserLog',
      collectorUrl: CFG.analyserCollectorUrl,
      payload:      JSON.stringify(entry),
    }).catch(() => {});
  }

  // ── b64 helper (mirrors verifier.b64ToBytes) ─────────────────────────────────

  function b64ToBytes(b64) {
    let s = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  }

  // ── Ed25519 verify with logging ───────────────────────────────────────────────

  async function runEd25519(strategyName, key, signature, parsedToken, contentHash) {
    if (!key) {
      _log({ type: 'ed25519', strategy: strategyName, valid: false, reason: 'no-key' });
      return false;
    }
    if (!signature) {
      _log({ type: 'ed25519', strategy: strategyName, valid: false, reason: 'no-signature' });
      return false;
    }
    const payload = canon.buildPayload(
      parsedToken.hash8, parsedToken.identity, contentHash, parsedToken.timestamp
    );
    try {
      const pubKey = await crypto.subtle.importKey(
        'raw', b64ToBytes(key.public_key), { name: 'Ed25519' }, false, ['verify']
      );
      const valid = await crypto.subtle.verify(
        { name: 'Ed25519' }, pubKey,
        b64ToBytes(signature), new TextEncoder().encode(payload)
      );
      _log({ type: 'ed25519', strategy: strategyName, valid });
      return valid;
    } catch (err) {
      _log({ type: 'ed25519', strategy: strategyName, valid: false, error: String(err.message) });
      return false;
    }
  }

  // ── main entry point ─────────────────────────────────────────────────────────

  async function analyse(textNode, parsedToken, rawPostText, platformId, pluginResult) {
    if (!CFG || !CFG.analyser) return;

    const processN = _nextProcess(parsedToken.raw);
    _log({
      type: 'start', hash8: parsedToken.hash8, processN, platform: platformId,
      identity: parsedToken.identity, isShort: parsedToken.isShort,
      content8: parsedToken.content8 || null,
    });

    // ── TRUNCATED check — must match verifier.TRUNCATION_THRESHOLD ─────────────
    const tokenIdx  = rawPostText.lastIndexOf('[SSD:');
    const preToken  = (tokenIdx !== -1 ? rawPostText.slice(0, tokenIdx) : rawPostText).trim();
    const threshold = (typeof verifier !== 'undefined') ? verifier.TRUNCATION_THRESHOLD : 20;
    if (preToken.length < threshold) {
      _log({ type: 'truncated', preTokenLen: preToken.length, threshold });
      _log({ type: 'outcome', state: 'TRUNCATED',
             pluginState: pluginResult ? pluginResult.state : 'unknown',
             strategyAMatch: null, strategyAVerified: false,
             strategyBMatch: null, strategyBVerified: false });
      return;
    }

    // Log what readPostText actually extracted — start and tail expose chrome bleed-in.
    _log({
      type:    'raw-text-info',
      byteLen: new TextEncoder().encode(preToken).length,
      start:   preToken.slice(0, 80).replace(/\n/g, '↵'),
      tail:    preToken.slice(-60).replace(/\n/g, '↵'),
    });

    // ── Strategy A: rawPostText through canon, stage by stage ──────────────────
    const stageA = await canon.canonicaliseVerbose(rawPostText);
    for (const s of stageA.stages) {
      const preview = s.json.slice(1, 42).replace(/\\n/g, '↵').replace(/\\t/g, '→');
      _log({ type: 'a-stage', stage: s.stage, byteLen: s.byteLen,
             json: s.json, preview });
    }
    const aContent8 = stageA.contentHash.slice(0, 8);
    const aMatch = parsedToken.content8 != null ? aContent8 === parsedToken.content8 : null;
    _log({ type: 'a-done', contentHash: stageA.contentHash, content8: aContent8,
           tokenContent8: parsedToken.content8 || null, match: aMatch });

    // ── Strategy B: suffix search (not on Twitter; requires content8 oracle) ───
    let bResult = null;
    if (platformId === 'twitter') {
      _log({ type: 'b-skip', reason: 'Twitter: Strategy-A-only (badge chrome contaminates suffix)' });
    } else if (!parsedToken.content8) {
      _log({ type: 'b-skip', reason: 'legacy token: no content8 oracle' });
    } else {
      bResult = await analyserSearcher.run(textNode, parsedToken.raw, parsedToken.content8);
      _log({ type: 'b-done', outcome: bResult.outcome, winner: bResult.winner,
             cacheUsed: bResult.cacheUsed, attemptCount: bResult.attempts.length });
      if (bResult.outcome === 'SEARCH_EXHAUSTED' || bResult.outcome === 'CACHE_STALE') {
        for (const a of bResult.attempts) _log({ type: 'b-attempt', ...a });
      } else if (bResult.outcome === 'RECOVERED' && bResult.winner) {
        const w    = bResult.winner;
        const winA = bResult.attempts.find(a =>
          a.depth === w.depth && a.suffixCount === w.suffixCount && a.variantId === w.variantId
        );
        if (winA) _log({ type: 'b-winner-text', byteLen: winA.byteLen, start: winA.canonJson.slice(1, 80) });
      }
    }

    const bMatch = !!(bResult && bResult.winner);

    // ── Key resolution ────────────────────────────────────────────────────────
    let key     = (typeof keyring !== 'undefined') ? keyring.get(parsedToken.hash8) : null;
    let keyPath = key ? 'local-keyring' : null;
    if (!key && typeof chrome !== 'undefined' && chrome.runtime) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'resolveKey', hash8: parsedToken.hash8, identity: parsedToken.identity,
        });
        if (resp && resp.ok && resp.key) {
          key     = resp.key;
          keyPath = 'service-worker-fetch';
          if (typeof keyring !== 'undefined') await keyring.load();
        } else {
          keyPath = 'sw-fail:' + (resp && resp.reason);
        }
      } catch (err) {
        keyPath = 'sw-unreachable:' + (err && err.message);
      }
    }
    if (!keyPath) keyPath = 'not-found';
    _log({ type: 'key', path: keyPath, resolved: !!key,
           keyHash8: key ? key.hash8 : null, name: key ? key.name : null });

    // ── Resolve full signature (short token → vault fetch) ────────────────────
    let signature = parsedToken.signature || null;
    if (parsedToken.isShort) {
      signature = await vault.fetchSig(
        parsedToken.hash8, parsedToken.sigHint, parsedToken.timestamp
      );
      _log({ type: 'sig-fetch', success: !!signature });
    }

    // ── Ed25519 verify for Strategy A (always attempted, prompt §6) ──────────
    const aVerified = await runEd25519('A', key, signature, parsedToken, stageA.contentHash);

    // ── Ed25519 verify for Strategy B (if B found a winner) ──────────────────
    let bVerified = false;
    if (bMatch) {
      const w          = bResult.winner;
      const bVariant   = analyserSearcher.VARIANTS.find(v => v.id === w.variantId);
      const bCandidates = analyserSearcher.buildCandidates(textNode, parsedToken.raw);
      const bCand      = bCandidates.find(c => c.depth === w.depth && c.suffixCount === w.suffixCount);
      if (bCand && bVariant) {
        const bCanon = await canon.canonicalise(bVariant.fn(bCand.text));
        bVerified = await runEd25519('B', key, signature, parsedToken, bCanon.contentHash);
      }
    }

    // ── Determine analysed state ──────────────────────────────────────────────
    let analysedState;

    if (aVerified || bVerified) {
      if (typeof keyring !== 'undefined' && key) {
        if      (keyring.isRevoked(key))                        analysedState = 'REVOKED';
        else if (keyring.isExpired(key, parsedToken.timestamp)) analysedState = 'EXPIRED';
        else analysedState = keyring.has(parsedToken.hash8) ? 'VALID' : 'VALID_UNKNOWN';
      } else {
        analysedState = 'VALID';
      }
    } else if (!key) {
      analysedState = 'KEY_UNREACHABLE';
    } else if (parsedToken.isShort && !signature) {
      analysedState = 'VAULT_UNREACHABLE';
    } else {
      // ── MISMATCH vs INVALID discrimination: log the path taken ─────────────
      let discPath  = 'heuristic';
      let verdict   = 'INVALID';
      let discDetail = '';

      try {
        const sigHint = parsedToken.isShort
          ? parsedToken.sigHint
          : (signature && typeof tokenParser !== 'undefined'
              ? tokenParser.sigHint(signature)
              : null);

        if (sigHint) {
          const discovered = await vault.query(parsedToken.hash8, sigHint);
          if (discovered && discovered.canonical_text != null) {
            discPath   = 'vault-query';
            discDetail = 'vault canonical_text len=' + discovered.canonical_text.length;
            const origCanon   = await canon.canonicalise(discovered.canonical_text);
            const origPayload = canon.buildPayload(
              parsedToken.hash8, parsedToken.identity,
              origCanon.contentHash,
              discovered.timestamp || parsedToken.timestamp
            );
            try {
              const pubKey = await crypto.subtle.importKey(
                'raw', b64ToBytes(key.public_key), { name: 'Ed25519' }, false, ['verify']
              );
              const ok = await crypto.subtle.verify(
                { name: 'Ed25519' }, pubKey,
                b64ToBytes(signature), new TextEncoder().encode(origPayload)
              );
              verdict     = ok ? 'MISMATCH' : 'INVALID';
              discDetail += '  vault-sig=' + (ok ? 'PASS→MISMATCH' : 'FAIL→INVALID');
            } catch (err) {
              discDetail += '  vault-verify-error=' + err.message;
            }
          } else {
            discDetail = 'vault: no canonical_text';
          }
        } else {
          discDetail = 'no sigHint';
        }
      } catch (err) {
        discDetail = 'vault-error=' + (err && err.message);
      }

      if (discPath === 'heuristic') {
        try {
          const sigBytes = signature ? b64ToBytes(signature) : new Uint8Array(0);
          verdict     = sigBytes.length === 64 ? 'MISMATCH' : 'INVALID';
          discDetail += '  sig-bytes=' + sigBytes.length + '→' + verdict;
        } catch (err) {
          discDetail += '  decode-error=' + err.message;
        }
      }

      _log({ type: 'disc', discPath, verdict });
      _log({ type: 'disc-detail', detail: discDetail });
      analysedState = verdict;
    }

    // ── Final outcome log ─────────────────────────────────────────────────────
    _log({
      type: 'outcome',
      state:             analysedState || 'INVALID',
      pluginState:       pluginResult ? pluginResult.state : 'unknown',
      strategyAMatch:    aMatch,
      strategyAVerified: aVerified,
      strategyBMatch:    bMatch,
      strategyBVerified: bVerified,
    });
  }

  return { analyse };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = analyser;
