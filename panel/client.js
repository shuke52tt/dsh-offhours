/**
 * nightshift 面板 · 客户端半（纯 JS，React 从浏览器模块表拿）
 *
 * 注册两处：
 *   1) sidebar.panellist  —— 左侧图标（id 与中央面板 key 同名，点它切到面板）
 *   2) main (keyed)       —— 中央面板本体
 * 文案走 client locale 服务（取不到时用内置中文兜底）；样式只用 --dsw-alias-* 主题 token（带 fallback）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-nightshift-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const API = '/nightshift/api'

    // 内置兜底文案（locale 服务不可用时用这些，界面不会出现空串或 key）
    const FALLBACK = {
      lastRunTitle: '最近一次跑批的输出（已完成）',
      liveEmpty: '还没有输出（等它开始吐字）',
      openWorkerSession: '打开处理会话（对话/轨迹）',
      liveTitle: '实时输出（正在跑的那张）',
      liveOpen: '查看实时输出',
      liveEmpty: '还没有输出（等它开始吐字）',
      liveFollow: '自动跟随最新',
      runningNowText: '正在跑批：',
      runningNow: '正在跑',
      fromSession: '派生会话',
      noSourceSession: '无来源会话（手工建卡）',
      selectedN: '已选',
      bulkRun: '按顺序执行选中',
      clearSel: '清除选择',
      batchHint: '勾选卡片（或整组）后可批量：执行 / 加去 auto / 加去 hold',
      detail: '展开详情',
      copyBrief: '复制讨论要点',
      copied: '已复制',
      runThisNow: '现在就做这张',
      budgetSettings: '设置（预算与阈值）',
      budgetSettingsOpen: '展开/收起（改完点保存，下一个 tick 生效）',
      save: '保存',
      saving: '保存中…',
      defaultLabel: '默认',
      budgetSettingsHint: '只允许白名单键；留空 = 用默认值；写进 env-<board>',
      keyHints: '键盘：← → 翻卡 · Cmd/Ctrl+Enter 批准 · F 全屏 · Esc 关闭',
      diagram: '架构/流程示意（ASCII）',
      restore: '还原',
      fullscreen: '全屏',
      openApproval: '打开审批窗口',
      approvalTitle: '待审批（explain-plain）',
      close: '关闭',
      prev: '上一张',
      next: '下一张',
      confirmAll: '全部按推荐批准',
      recommended: '推荐',
      willClose: '批准后直接归档',
      afterApprove: '批准后',
      ifNotApprove: '不批准',
      rawForm: '展开原始审批单/送审说明',
      noForm: '这张卡还没有审批单（可先在会话里让我补）。',
      cost: '今日花费',
      scanNowForced: '现在就做一张',
      confirmDecisionHint: '写清你的结论（≥8 字）——会写进卡片，下一个跑批照着做',
      confirmDetailHint: '执行要点（可选）：批准后它该做什么、边界在哪',
      confirmUnhold: '同时解除 hold（允许无人值守捡它）',
      confirmGo: '确认 → 回到待办',
      confirming: '确认中…',
      confirmTooShort: '结论至少 8 个字',

      title: '夜间跑批',
      subtitle: '空闲 + 低谷时自动处理看板待办；你在用电脑时不会跑',
      statePeak: '高峰时段',
      stateOffpeak: '低谷时段',
      statePaused: '已暂停',
      stateRunning: '运行中',
      timer: '定时器',
      nextScan: '下次扫描',
      cooldown: '冷却',
      budget: '今日预算',
      cards: '张卡',
      minutes: '分钟',
      todo: '待办队列',
      review: '待审（等你确认）',
      running: '正在跑',
      recent: '最近结果',
      emptyTodo: '暂无待办卡片。',
      emptyReview: '没有等你确认的卡片。',
      emptyRunning: '现在没有在跑的卡。',
      pause: '暂停',
      resume: '恢复',
      scanNow: '立即扫描一次',
      scanStarted: '已启动一次扫描；是否真正开工由正常门控决定。',
      needsDecision: '需你拍板',
      auto: 'auto 优先',
      hold: '永不自动跑',
      loadError: '读不到 nightshift 状态',
      loading: '加载中…',
      refresh: '刷新',
      lastRefresh: '最近刷新',
      soon: '即将',
      none: '无',
      idle: '空闲',
      busy: '忙',
      problems: '提示',
    }

    function makeDict(ctx) {
      let svc = null
      try {
        svc = ctx.get('locale')
      } catch {
        svc = null
      }
      const tryCall = (fn, key) => {
        try {
          const v = fn(key)
          if (typeof v === 'string' && v && v !== key) return v
        } catch {
          /* 某个方法签名不匹配就跳过 */
        }
        return null
      }
      return (key, fallback) => {
        const full = `panel.${key}`
        if (svc) {
          for (const name of ['t', 'text', 'translate', 'get']) {
            if (typeof svc[name] === 'function') {
              const v = tryCall(svc[name].bind(svc), full)
              if (v) return v
            }
          }
        }
        return fallback || FALLBACK[key] || key
      }
    }

    // ----------------------------------------------------------- 状态仓库
    // 面板跟随哪个看板：记住上次选择（默认 ops）。2026-10-16 修：此前写死 ops，
    // 导致 hemou 板（象族线那 36 张待办 / 7 张 auto）在界面上完全看不到。
    const BOARD_LS = 'nightshift.board'
    function readBoardPref() {
      try { return localStorage.getItem(BOARD_LS) || 'ops' } catch { return 'ops' }
    }

    function createStore() {
      let state = { loading: true, data: null, error: null, busy: null, toast: null, at: null, board: readBoardPref(), approvalOpen: false, liveOpen: false }
      const subs = new Set()
      const set = (patch) => {
        state = { ...state, ...patch }
        for (const fn of Array.from(subs)) {
          try {
            fn(state)
          } catch {
            /* 单个订阅者出错不影响其它 */
          }
        }
      }
      async function refresh() {
        try {
          const res = await fetch(`${API}/status?board=${encodeURIComponent(state.board)}`, { headers: { accept: 'application/json', 'x-nightshift': '1' }, cache: 'no-store' })
          const json = await res.json()
          if (json && json.ok === false) set({ loading: false, error: json.error || FALLBACK.loadError })
          else set({ loading: false, data: json, error: null, at: new Date() })
        } catch (e) {
          set({ loading: false, error: `${FALLBACK.loadError}：${(e && e.message) || e}` })
        }
      }
      async function act(action, payload) {
        set({ busy: action, toast: null })
        try {
          const res = await fetch(`${API}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-nightshift': '1' },
            body: JSON.stringify({ action, board: state.board, ...(payload || {}) }),
          })
          const json = await res.json()
          set({ busy: null, toast: json && json.ok ? json.message || '完成' : `失败：${(json && json.error) || '未知错误'}` })
        } catch (e) {
          set({ busy: null, toast: `失败：${(e && e.message) || e}` })
        }
        await refresh()
      }
      return {
        get: () => state,
        subscribe(fn) {
          subs.add(fn)
          return () => subs.delete(fn)
        },
        setLiveOpen(open) {
          state = { ...state, liveOpen: !!open }
          for (const fn of Array.from(subs)) {
            try { fn(state) } catch { /* 单个订阅者出错不影响其它 */ }
          }
        },
        setApprovalOpen(open) {
          state = { ...state, approvalOpen: !!open }
          for (const fn of Array.from(subs)) {
            try { fn(state) } catch { /* 单个订阅者出错不影响其它 */ }
          }
        },
        setBoard(key) {
          if (!key || key === state.board) return Promise.resolve()
          state = { ...state, board: key, loading: true, toast: null }
          try { localStorage.setItem(BOARD_LS, key) } catch { /* 隐私模式等场景忽略 */ }
          for (const fn of Array.from(subs)) {
            try { fn(state) } catch { /* 单个订阅者出错不影响其它 */ }
          }
          return refresh()
        },
        refresh,
        act,
      }
    }

    function useStore(store) {
      const [snap, setSnap] = useState(store.get())
      useEffect(() => store.subscribe(setSnap), [store])
      return snap
    }

    // ----------------------------------------------------------- 基础样式
    const T = {
      bg: 'var(--dsw-alias-bg-base, transparent)',
      card: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,0.06))',
      border: 'var(--dsw-alias-border-secondary, rgba(128,128,128,0.28))',
      borderStrong: 'var(--dsw-alias-border-primary, rgba(128,128,128,0.4))',
      text: 'var(--dsw-alias-text-primary, inherit)',
      textSub: 'var(--dsw-alias-text-secondary, rgba(128,128,128,0.95))',
      fill: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,0.12))',
      brand: 'var(--dsw-alias-brand-primary, #4f7cff)',
      warn: 'var(--dsw-alias-text-warning, #d98b00)',
      danger: 'var(--dsw-alias-text-danger, #d9534f)',
      ok: 'var(--dsw-alias-text-success, #2f9e6b)',
    }
    const mono = 'var(--dsw-alias-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

    const cardStyle = {
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 10,
      padding: '10px 12px',
    }

    function Chip(props) {
      const tone = props.tone || 'default'
      const color = tone === 'ok' ? T.ok : tone === 'warn' ? T.warn : tone === 'danger' ? T.danger : tone === 'brand' ? T.brand : T.textSub
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: 999,
            border: `1px solid ${T.border}`,
            background: T.fill,
            color,
            fontSize: 11,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function Button(props) {
      const disabled = !!props.disabled
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick: props.onClick,
          // 供手机上「主按钮占满整行」的窄屏 CSS 选择（见 ApprovalWindow 的 <style>）
          'data-ns-primary': props.primary ? '1' : undefined,
          style: {
            padding: '5px 12px',
            borderRadius: 8,
            border: `1px solid ${props.primary ? T.brand : T.borderStrong}`,
            background: props.primary ? 'var(--dsw-alias-fill-brand, rgba(79,124,255,0.16))' : T.fill,
            color: props.primary ? T.brand : T.text,
            fontSize: 12,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
          },
        },
        props.children,
      )
    }

    function Section(props) {
      return h(
        'section',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, props.title),
          typeof props.count === 'number' ? h(Chip, null, String(props.count)) : null,
          h('div', { style: { flex: 1 } }),
          props.extra || null,
        ),
        props.children,
      )
    }

    function Row(props) {
      return h(
        'div',
        { style: { ...cardStyle, display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { fontSize: 13, color: T.text, wordBreak: 'break-word' } }, props.title),
        props.meta ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, props.meta) : null,
        props.body || null,
      )
    }

    // ----------------------------------------------------------- 侧栏图标
    function MoonCheck(props) {
      const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true, focusable: false, style: { display: 'block' } },
        h('path', { d: 'M43 17a14 14 0 1 0 0 23.5A17 17 0 0 1 43 17z', fill: props.color || 'currentColor' }),
        h('g', { stroke: 'currentColor', strokeWidth: 3.4, strokeLinecap: 'round', opacity: 0.85 },
          h('path', { d: 'M13 44h15' }),
          h('path', { d: 'M13 51h9' }),
        ),
        h('path', { d: 'M32 49.5l3.4 3.4 6.6-7', fill: 'none', stroke: 'currentColor', strokeWidth: 3.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function SidebarEntry(props) {
      const active = !!(props && props.active)
      const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 20
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            height: '100%',
            color: active ? T.brand : T.textSub,
            opacity: active ? 1 : 0.8,
          },
          'aria-hidden': true,
        },
        h(MoonCheck, { size }),
      )
    }

    // ----------------------------------------------------------- 中央面板
    // 「确认」小表单：把人在界面上的结论写回卡片（确认后状态回 todo，下一个跑批照着做）。
    // 这是 2026-10-16 用户要求的特性：「待审」不能是黑洞，讨论确认后要能进入可执行的待办。
    const confirmInputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      fontSize: 12,
      fontFamily: 'inherit',
      color: 'var(--dsw-alias-text-primary, inherit)',
      background: 'var(--dsw-alias-fill-secondary, transparent)',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
      borderRadius: 8,
      padding: '6px 8px',
      resize: 'vertical',
    }

    /** 解析卡里的 explain-plain 审批单（窗口据此渲染选项按钮）。 */
    function parseApproval(text) {
      const lines = String(text || '').split('\n')
      const field = (label) => {
        const l = lines.find((x) => x.trim().startsWith(label + '：') || x.trim().startsWith(label + ':'))
        return l ? l.replace(/^[^：:]*[：:]\s*/, '').trim() : ''
      }
      const options = []
      for (const l of lines) {
        const m = /^\s*-\s*O(\d+)\s*[：:]\s*(.+)$/.exec(l)
        if (!m) continue
        const parts = m[2].split('｜')
        options.push({
          n: m[1],
          text: parts[0].trim(),
          rest: parts.slice(1).join('｜').trim(),
          recommended: /推荐/.test(m[2]),
          closes: /动作[：:]\s*done/.test(m[2]),
        })
      }
      return {
        one: field('一句话'), where: field('卡在哪'), why: field('前因'),
        after: field('批准后'), deny: field('不批准'), options,
        hasForm: lines.some((l) => l.includes('【审批单 · explain-plain】')),
      }
    }

    /** 窄屏（手机）判定：审批窗口在手机上要变全宽 sheet、加大触控目标、留安全区。 */
    function useNarrow() {
      const [narrow, setNarrow] = useState(() => {
        try { return window.matchMedia('(max-width: 640px)').matches } catch { return false }
      })
      useEffect(() => {
        try {
          const mq = window.matchMedia('(max-width: 640px)')
          const on = (e) => setNarrow(e.matches)
          mq.addEventListener('change', on)
          return () => mq.removeEventListener('change', on)
        } catch { return undefined }
      }, [])
      return narrow
    }

    /** 从审批单里抽出 ```text 围栏里的 ASCII 图（explain-plain 图文并茂那部分）。 */
    function extractDiagram(text) {
      const m = /```text\n([\s\S]*?)```/.exec(String(text || ''))
      return m ? m[1].replace(/\s+$/, '') : ''
    }

    /** 实时输出窗口：轮询 /nightshift/api/live，把正在跑那张卡的 --json 事件流显示出来。
     *  thinking=模型的思考流（暗色）、text=回答流、final=最终答复、phase=阶段。 */
    function LiveWindow(props) {
      const { store, t } = props
      const [snap, setSnap] = useState(store.get())
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => store.subscribe(setSnap), [store])
      useEffect(() => {
        if (!snap.liveOpen) return undefined
        let stop = false
        const tick = async () => {
          try {
            const r = await fetch(`${API}/live?board=${encodeURIComponent(snap.board || 'ops')}`, { headers: { 'x-nightshift': '1' } })
            const j = await r.json()
            if (!stop) { setData(j); setErr('') }
          } catch (e) { if (!stop) setErr(String((e && e.message) || e)) }
          const el = document.getElementById('ns-live-body')
          if (el) el.scrollTop = el.scrollHeight
        }
        tick()
        const timer = setInterval(tick, 2000)
        return () => { stop = true; clearInterval(timer) }
      }, [snap.liveOpen, snap.board])
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') store.setLiveOpen(false) }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [store])
      if (!snap.liveOpen) return null
      const rn = (data && data.running) || {}
      const lines = (data && data.lines) || []
      const shell = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1210 }
      const box = { width: 'min(1100px, 95vw)', height: '88vh', display: 'flex', flexDirection: 'column', gap: 8, background: T.bg, color: T.text, border: `1px solid ${T.borderStrong}`, borderRadius: 12, padding: 14 }
      return h(
        'div',
        { style: shell, onClick: (e) => { if (e.target === e.currentTarget) store.setLiveOpen(false) } },
        h(
          'div',
          { style: box },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 15, fontWeight: 700, color: (data && data.finishedRun) ? T.text : '#1a8f5a' } }, (data && data.finishedRun) ? `◍ ${t('lastRunTitle')}` : `● ${t('liveTitle')}`),
            h('div', { style: { fontSize: 12, color: T.textSub } },
              (rn.title || '(未在跑)') + (rn.count ? `　worker×${rn.count}` : '') +
                (rn.since ? `　已跑 ${Math.max(0, Math.round((Date.now() / 1000 - rn.since) / 60))} 分钟` : '')),
            h('div', { style: { flex: 1 } }),
            h('div', { style: { fontSize: 11, color: T.textSub } }, `${lines.length} 条 · ${(data && data.outBytes) || 0} 字节 · ${t('liveFollow')}`),
            (data && data.running && data.running.workerSessionId)
              ? h(Button, { onClick: () => openWorkerSession(data.running.workerSessionId) }, t('openWorkerSession'))
              : null,
            h(Button, { onClick: () => store.setLiveOpen(false) }, t('close')),
          ),
          err ? h('div', { style: { fontSize: 12, color: '#c0392b' } }, err) : null,
          h(
            'div',
            { id: 'ns-live-body', style: { flex: 1, minHeight: 0, overflow: 'auto', background: T.fill, borderRadius: 8, padding: '10px 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.5 } },
            lines.length === 0
              ? h('div', { style: { color: T.textSub } }, t('liveEmpty'))
              : lines.map((l, i) =>
                  h('div', {
                    key: i,
                    style: l.kind === 'think' ? { color: T.textSub, fontStyle: 'italic', whiteSpace: 'pre-wrap' }
                      : l.kind === 'phase' ? { color: T.textSub, fontSize: 11, whiteSpace: 'pre-wrap' }
                      : l.kind === 'final' ? { color: '#1a8f5a', fontWeight: 600, whiteSpace: 'pre-wrap', borderTop: `1px solid ${T.borderStrong}`, marginTop: 6, paddingTop: 6 }
                      : { whiteSpace: 'pre-wrap' },
                  }, (l.kind === 'think' ? '💭 ' : l.kind === 'phase' ? '· ' : '') + String(l.text || ''))),
          ),
        ),
      )
    }

    /** 专门的「审批窗口」：一次一张待审卡，展示 explain-plain 审批单（前因后果），
     *  点选项即把结论填好，确认后写回卡片并回到待办（或按推荐直接归档）。Esc 关闭。 */
    function ApprovalWindow(props) {
      const { store, t } = props
      const [snap, setSnap] = useState(store.get())
      const [idx, setIdx] = useState(0)
      const [decision, setDecision] = useState('')
      const [detail, setDetail] = useState('')
      const [unhold, setUnhold] = useState(false)
      const narrow = useNarrow()
      const [copied, setCopied] = useState('')
      const [big, setBig] = useState(() => {
        try { return localStorage.getItem('ns-approval-big') === '1' } catch { return false }
      })
      useEffect(() => store.subscribe(setSnap), [store])
      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') store.setApprovalOpen(false) }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [store])
      if (!snap.approvalOpen) return null

      const cards = (snap.data && snap.data.reviews) || []
      const busy = snap.busy === 'confirm' || snap.busy === 'confirm-all'
      const card = cards.length ? cards[Math.min(idx, cards.length - 1)] : null
      // 审批单与图可能落在 note（最近送审）或 description（整段说明）里 ⇒ 两处都找
      const noteText = card ? String(card.note || '') : ''
      const descText = card ? String(card.detail || '') : ''
      const formA = card ? parseApproval(noteText) : { options: [] }
      const formB = card ? parseApproval(descText) : { options: [] }
      const form = (formA.options || []).length >= (formB.options || []).length ? formA : formB
      const diagram = (card && (extractDiagram(noteText) || extractDiagram(descText))) || ''
      // 兜底：新格式的说明把 ASCII 图放在正文里（不是旧审批单的「图：」）⇒ 从全文抓第一个 text 围栏
      const fullText = card ? String(card.detail || card.summary || '') : ''
      const diagram2 = diagram || ((fullText.match(/```text\n([\s\S]*?)\n```/) || [])[1] || '').trim()
      // 说明全文（去掉围栏块，图已单独渲染在上方，避免重复且避免手机上被折行毁掉）
      const explainText = fullText.replace(/```text[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim()

      const shell = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: narrow ? 'stretch' : 'center', justifyContent: 'center', zIndex: 1200 }
      const box = {
        ...(narrow
          // 手机：整屏 sheet。padding 必须写在各分支里、且 paddingBottom 放在 padding 之后，
          // 否则后面的 `padding: 16` 会把 safe-area 覆盖掉（2026-10-18 实测踩过）。
          ? { width: '100vw', height: '100dvh', maxHeight: '100dvh', borderRadius: 0,
              padding: 12, paddingBottom: 'calc(12px + env(safe-area-inset-bottom))' }
          : big
            ? { width: '100vw', height: '100vh', maxHeight: '100vh', borderRadius: 0, padding: 16 }
            : { width: 'min(960px, 94vw)', maxHeight: '90vh', borderRadius: 12, padding: 16 }),
        // 100vw/100dvh + padding 在 content-box 下会撑出视口（实测 390x844 时窗口 878 高，
        // 底部按钮被截掉一截）⇒ 一律 border-box。
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: T.bg,
        color: T.text,
        border: `1px solid ${T.borderStrong}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: '0 14px 44px rgba(0,0,0,0.4)',
      }
      const mono = {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: narrow ? 11 : big ? 13 : 12,
        lineHeight: 1.45,
        whiteSpace: 'pre',
        overflowX: 'auto',
        background: T.fill,
        borderRadius: 8,
        padding: '10px 12px',
        margin: 0,
        color: T.text,
      }
      const pre = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: narrow ? 13 : 12, lineHeight: narrow ? 1.6 : 1.5, color: T.textSub, background: T.fill, borderRadius: 8, padding: '8px 10px' }
      const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
      const reset = () => { setDecision(''); setDetail(''); setUnhold(false) }

      return h(
        'div',
        {
          style: shell,
          id: 'ns-approval-shell',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('approvalTitle'),
          onClick: (e) => { if (e.target === e.currentTarget) store.setApprovalOpen(false) },
        },
        h(
          'div',
          { style: box },
          narrow
            ? h('style', { dangerouslySetInnerHTML: { __html: [
                '#ns-approval-shell button{min-height:44px}',
                '#ns-approval-shell button[data-ns-primary="1"]{flex:1 1 100%}',
              ].join('\n') } })
            : null,
          h(
            'div',
            { style: { ...row, justifyContent: 'space-between' } },
            h('div', { style: { fontSize: 16, fontWeight: 700 } },
              `${t('approvalTitle')}${cards.length ? ` (${Math.min(idx, cards.length - 1) + 1}/${cards.length})` : ''}`),
            h(
              'div',
              { style: { display: 'flex', gap: 8 } },
              h(Button, {
                  title: '把标题 + 一句话 + 前因 + 选项复制到剪贴板，粘到会话里继续讨论',
                  onClick: () => {
                    const txt = [
                      card.title,
                      form.one ? `一句话：${form.one}` : '',
                      form.where ? `卡在哪：${form.where}` : '',
                      form.why ? `前因：${form.why}` : '',
                      form.options.length ? '选项：' : '',
                      ...form.options.map((o) => `- O${o.n}：${o.text}${o.rest ? `｜${o.rest}` : ''}`),
                      '',
                      '（更完整的上下文见卡片说明全文）',
                    ].filter(Boolean).join('\n')
                    const fallback = () => {
                      try {
                        const ta = document.createElement('textarea')
                        ta.value = txt; document.body.appendChild(ta); ta.select()
                        document.execCommand('copy'); document.body.removeChild(ta)
                      } catch (e) { /* 忽略：手机上剪贴板权限可能被拒 */ }
                    }
                    try { navigator.clipboard.writeText(txt).then(() => {}, fallback) } catch (e) { fallback() }
                  },
                }, narrow ? '复制' : '复制讨论要点'),
                h(Button, { onClick: () => setBig((v) => { const nv = !v; try { localStorage.setItem('ns-approval-big', nv ? '1' : '0') } catch { /* 忽略 */ } return nv }) }, big ? t('restore') : t('fullscreen')),
              h(Button, { onClick: () => store.setApprovalOpen(false) }, t('close')),
            ),
          ),
          h(WindowKeys, {
            onPrev: () => { if (cards.length > 1) { setIdx((v) => (v - 1 + cards.length) % cards.length); reset() } },
            onNext: () => { if (cards.length > 1) { setIdx((v) => (v + 1) % cards.length); reset() } },
            onConfirm: () => { if (card && decision.trim().length >= 8 && !busy) store.act('confirm', { cardId: card.id, decision, detail, unhold }).then(reset) },
            canConfirm: !!card && decision.trim().length >= 8 && !busy,
            onToggleBig: () => setBig((v) => { const nv = !v; try { localStorage.setItem('ns-approval-big', nv ? '1' : '0') } catch { /* 隐私模式忽略 */ } return nv }),
          }),
          !cards.length
            ? h('div', { style: { fontSize: 13, color: T.textSub } }, t('emptyReview'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, overflow: 'auto', paddingRight: 4 } },
                h('div', { style: { fontSize: 16, fontWeight: 700, wordBreak: 'break-word' } }, card.title),
                form.one ? h('div', { style: { fontSize: 14, fontWeight: 600, lineHeight: 1.5 } }, form.one) : null,
                diagram2
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('div', { style: { fontSize: 11, color: T.textSub } }, t('diagram') + (narrow ? '（可左右滑动看全图）' : '')),
                      h('pre', { style: mono }, diagram2))
                  : null,
                explainText
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                      h('div', { style: { fontSize: 11, color: T.textSub } },
                        '说明全文（不截断；框内可滚动，点右上角「放大」看全屏）'),
                      h('pre', { style: { ...pre, maxHeight: big ? 'none' : (narrow ? '46vh' : '52vh'), overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: narrow ? 13 : 12, lineHeight: narrow ? 1.6 : 1.55 } }, explainText))
                  : null,
                form.where || form.why
                  ? (narrow
                      // 手机上把「卡在哪/前因」做成可折叠，默认展开（长前因时可收起）
                      ? h('details', { open: true, style: pre },
                          h('summary', { style: { cursor: 'pointer', fontSize: 12, color: T.textSub, minHeight: 32, display: 'flex', alignItems: 'center' } }, '前因 / 卡点（点开或收起）'),
                          h('div', { style: { marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                            [form.where ? `卡在哪：${form.where}` : '', form.why ? `前因：${form.why}` : ''].filter(Boolean).join('\n\n')))
                      : h('div', { style: pre }, [form.where ? `卡在哪：${form.where}` : '', form.why ? `前因：${form.why}` : ''].filter(Boolean).join('\n\n')))
                  : null,
                form.options.length
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 6, order: big ? -1 : 0,
                               ...(/fullscreen/.test(String(big)) ? {} : {}) } },
                      form.options.map((o) =>
                        h(
                          'button',
                          {
                            key: `opt-${o.n}`,
                            onClick: () => { setDecision(`采用 O${o.n}：${o.text}`); setDetail(form.after || '') },
                            style: {
                              textAlign: 'left', fontSize: narrow ? 13 : 12, fontFamily: 'inherit', color: T.text,
                              background: T.fill, border: `1px solid ${o.recommended ? T.brand : T.borderStrong}`,
                              borderRadius: 8, padding: narrow ? '12px 12px' : '8px 10px', minHeight: narrow ? 44 : 0, cursor: 'pointer',
                            },
                          },
                          [`O${o.n}　${o.text}`, o.rest ? `　（${o.rest}）` : '', o.recommended ? `　← ${t('recommended')}` : '', o.closes ? `　[${t('willClose')}]` : ''].join(''),
                        ),
                      ),
                    )
                  : h('div', { style: { fontSize: 12, color: T.textSub } }, t('noForm')),
                form.after ? h('div', { style: { fontSize: 12 } }, `${t('afterApprove')}：${form.after}`) : null,
                form.deny ? h('div', { style: { fontSize: 12, color: T.textSub } }, `${t('ifNotApprove')}：${form.deny}`) : null,
                h('details', { style: { fontSize: 12 } },
                  h('summary', { style: { cursor: 'pointer', color: T.textSub } }, t('rawForm')),
                  h('pre', { style: mono }, card.note || '')),
              ),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, order: big ? -1 : 0, borderTop: `1px solid ${T.borderStrong}`, paddingTop: 10 } },
                h('textarea', { value: decision, rows: 2, placeholder: t('confirmDecisionHint'), onChange: (e) => setDecision(e.target.value), style: confirmInputStyle }),
                h('textarea', { value: detail, rows: 2, placeholder: t('confirmDetailHint'), onChange: (e) => setDetail(e.target.value), style: confirmInputStyle }),
                h(
                  'div',
                  { style: row },
                  card.hold
                    ? h('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: T.textSub } },
                        h('input', { type: 'checkbox', checked: unhold, onChange: (e) => setUnhold(e.target.checked) }), t('confirmUnhold'))
                    : null,
                  // 一键「审核通过 → 回待办」：新格式的卡没有 - O<n>： 行时也能一键通过
                  h(Button, {
                    primary: true,
                    disabled: busy,
                    onClick: () => store.act('confirm', {
                      cardId: card.id,
                      decision: '审核通过（按卡内推荐执行）',
                      detail: '人审通过 ⇒ 回到待办，由后续轮次按卡内推荐执行',
                      unhold: true,
                    }).then(reset),
                  }, narrow ? '✓ 通过' : '✓ 审核通过（回待办）'),
                  h(Button, {
                    primary: true,
                    disabled: busy || decision.trim().length < 8,
                    onClick: () => store.act('confirm', { cardId: card.id, decision, detail, unhold }).then(reset),
                  }, busy ? t('confirming') : t('confirmGo')),
                  h(Button, { disabled: cards.length < 2, onClick: () => { setIdx((v) => (v - 1 + cards.length) % cards.length); reset() } }, t('prev')),
                  h(Button, { disabled: cards.length < 2, onClick: () => { setIdx((v) => (v + 1) % cards.length); reset() } }, t('next')),
                  h(Button, { disabled: busy, onClick: () => store.act('confirm-all') }, t('confirmAll')),
                  h(Button, {
                    disabled: busy,
                    onClick: () => {
                      const brief = `【待审卡】${card.title}\n卡 id：${card.id}\n\n${card.note || ''}\n\n请帮我把这张卡的方案讨论清楚：逐条回答上面的选项，给出结论与执行要点；我确认后再放回待办或现在就执行。`
                      try {
                        navigator.clipboard.writeText(brief)
                        setCopied(t('copied'))
                        setTimeout(() => setCopied(''), 2500)
                      } catch { setCopied('复制失败（浏览器未授权剪贴板）') }
                    },
                  }, copied || t('copyBrief')),
                  h(Button, { disabled: busy || !card, onClick: () => store.act('scan-this', { cardId: card.id }) }, t('runThisNow')),
                ),
                narrow ? null : h('div', { style: { fontSize: 11, color: T.textSub } }, t('keyHints')),
                ),
        ),
      )
    }

    /** 模态窗口的键盘与副作用：Esc 关闭、← → 翻卡、Cmd/Ctrl+Enter 批准、F 全屏；
     *  打开时锁滚动并把焦点移进窗口，关闭时自动恢复。 */
    function WindowKeys(props) {
      const { onPrev, onNext, onConfirm, canConfirm, onToggleBig } = props
      useEffect(() => {
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        const el = document.getElementById('ns-approval-shell')
        if (el && typeof el.focus === 'function') el.focus()
        const onKey = (e) => {
          const typing = /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')
          if (e.key === 'Escape') return // Esc 交给 ApprovalWindow 自己的监听处理，避免递归派发
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { if (canConfirm) onConfirm(); return }
          if (typing) return
          if (e.key === 'ArrowLeft') onPrev()
          else if (e.key === 'ArrowRight') onNext()
          else if (e.key === 'f' || e.key === 'F') onToggleBig()
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.body.style.overflow = prevOverflow
        }
      }, [onPrev, onNext, onConfirm, canConfirm, onToggleBig])
      return null
    }

    /** 待办队列：按"派生它的会话"分组 + 可展开详情 + 勾选后批量处理。
     *  分组键是卡片的 sourceSessionId（没有的归到"无来源会话"），组头显示该会话关联的特性/工程。 */
    function TodoQueue(props) {
      const narrow = useNarrow()
      const { todos, store, t, runningNow, density } = props
      const comfy = density !== 'compact'
      const relTime = (ts) => { if (!ts) return ''; const m = Math.max(0, Math.round((Date.now() - ts) / 60000))
        return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前` }
      const [sel, setSel] = useState({})
      const rn = runningNow || { count: 0, cardId: '', since: null }
      const isRunning = (c) => !!rn.cardId && c.id === rn.cardId && rn.count > 0
      const runMinutes = (c) => (isRunning(c) && rn.since ? Math.max(0, Math.round((Date.now() / 1000 - rn.since) / 60)) : null)
      const selIds = Object.keys(sel).filter((k) => sel[k])
      const busy = store.get().busy === 'bulk-cards'
      const groups = []
      const byKey = {}
      for (const c of todos) {
        const k = c.sourceSessionId || ''
        if (byKey[k] === undefined) { byKey[k] = { key: k, label: c.sessionLabel || '', items: [] }; groups.push(byKey[k]) }
        byKey[k].items.push(c)
      }
      const toggle = (id) => setSel({ ...sel, [id]: !sel[id] })
      const selectGroup = (g, on) => { const n = { ...sel }; for (const c of g.items) n[c.id] = on; setSel(n) }
      const bulk = (op, value) => store.act('bulk-cards', { ids: selIds, op, value }).then(() => setSel({}))
      const bar = { position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30, display: 'flex', gap: 8, alignItems: 'center',
        overflowX: 'auto', whiteSpace: 'nowrap', background: T.bg, borderTop: `1px solid ${T.borderStrong}`,
        boxShadow: '0 -6px 20px rgba(0,0,0,0.10)', padding: narrow ? '10px 12px calc(10px + env(safe-area-inset-bottom))' : '10px 16px' }
      const grp = { display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${T.borderStrong}`, borderRadius: 10, padding: 10 }
      const head = { display: 'flex', gap: 6, alignItems: 'center' }
      const row = { display: 'flex', flexDirection: 'column', gap: comfy ? 6 : 3, padding: comfy ? (narrow ? '12px 12px' : '10px 12px') : '7px 9px', borderRadius: 14, background: T.bg, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', border: `1px solid ${T.borderStrong}`, borderRadius: 8 }
      const runningStyle = { borderLeft: '3px solid #1a8f5a', background: 'rgba(26,143,90,0.07)' }
      const dot = { width: 8, height: 8, borderRadius: 4, background: '#1a8f5a', display: 'inline-block' }
      const pre = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, color: T.textSub, background: T.fill, borderRadius: 8, padding: '8px 10px', maxHeight: 260, overflow: 'auto' }
      const chip = (key, tone, label) => h(Chip, { key, tone }, label)
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: selIds.length ? 92 : 8 } },
        selIds.length
          ? h('div', { style: bar },
              h('div', { style: { fontSize: 12, fontWeight: 600 } }, `${t('selectedN')} ${selIds.length}`),
              h(Button, { primary: true, disabled: busy, onClick: () => bulk('run-now') }, t('bulkRun')),
              h(Button, { disabled: busy, onClick: () => bulk('add-tag', 'auto') }, '+auto'),
              h(Button, { disabled: busy, onClick: () => bulk('remove-tag', 'auto') }, '-auto'),
              h(Button, { disabled: busy, onClick: () => bulk('add-tag', 'hold') }, '+hold'),
              h(Button, { disabled: busy, onClick: () => bulk('remove-tag', 'hold') }, '-hold'),
              h(Button, { onClick: () => setSel({}) }, t('clearSel')))
          : h('div', { style: { fontSize: 11, color: T.textSub } }, t('batchHint')),
        groups.map((g) =>
          h('div', { key: g.key || '__none__', style: grp },
            h('div', { style: head },
              h('input', { type: 'checkbox', checked: g.items.length > 0 && g.items.every((c) => sel[c.id]), onChange: (e) => selectGroup(g, e.target.checked) }),
              h('div', { style: { fontSize: 12, fontWeight: 600 } },
                (g.key ? `${t('fromSession')} ${g.key.replace('session-', '').slice(0, 12)}…` : t('noSourceSession')) + (g.label ? `　(${g.label})` : '')),
              h(Chip, null, String(g.items.length)),
            ),
            g.items.map((c) =>
              h('div', { key: c.id, style: isRunning(c) ? { ...row, ...runningStyle } : row },
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
                  h('input', { type: 'checkbox', checked: !!sel[c.id], onChange: () => toggle(c.id) }),
                  h('div', { style: { flex: 1, fontSize: comfy ? 13.5 : 12.5, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, c.title)),
                isRunning(c)
                  ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: '#1a8f5a', fontWeight: 600 } },
                      h('span', { style: dot }),
                      `${t('runningNow')}${runMinutes(c) === null ? '' : `（已跑 ${runMinutes(c)} 分钟）`}`)
                  : null,
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 10.5, color: T.textSub } },
                  relTime(c.updatedAt) ? h('span', null, relTime(c.updatedAt)) : null,
                  h('span', null, '·'),
                  h('span', { style: { fontFamily: 'ui-monospace,Menlo,monospace' } }, String(c.id || '').slice(0, 12))),
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  [c.auto ? chip('a', 'brand', t('auto')) : null,
                   c.decision ? chip('d', 'warn', t('needsDecision')) : null,
                   c.hold ? chip('h', 'danger', t('hold')) : null].filter(Boolean)),
                h('details', null,
                  h('summary', { style: { cursor: 'pointer', fontSize: 11, color: T.textSub } }, t('detail')),
                  h('div', { style: pre },
                    (c.detail || '') +
                      (c.why ? `\n\n【为什么】${c.why}` : '') +
                      (c.rejected ? `\n\n【放弃了什么】${c.rejected}` : '') +
                      (c.sourceSessionId ? `\n\n【来源会话】${c.sourceSessionId}` : ''))),
                h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  h(Button, { onClick: () => store.act('scan-this', { cardId: c.id }) }, t('runThisNow')),
                  c.workerSessionId
                    ? h(Button, { onClick: () => openWorkerSession(c.workerSessionId) }, t('openWorkerSession'))
                    : null,
                  h(Button, { onClick: () => store.act('bulk-cards', { ids: [c.id], op: c.auto ? 'remove-tag' : 'add-tag', value: 'auto' }) }, c.auto ? '-auto' : '+auto'),
                  h(Button, { onClick: () => store.act('bulk-cards', { ids: [c.id], op: c.hold ? 'remove-tag' : 'add-tag', value: 'hold' }) }, c.hold ? '-hold' : '+hold'),
                  h(Button, {
                    onClick: () => { try { navigator.clipboard.writeText(`${c.title}\n\n${c.detail || ''}`) } catch { /* 忽略 */ } },
                  }, t('copyBrief')))))))
      )
    }

    /** 预算设置：白名单键的行式编辑（值写进 env-<board>，unit 的 EnvironmentFile 下次启动即生效）。 */
    function BudgetSettings(props) {
      const { settings, store, t } = props
      const keys = Object.keys(settings.keys || {})
      const [vals, setVals] = useState(() => ({ ...settings.effective }))
      const busy = store.get().busy === 'set-budget'
      const input = {
        width: 90, boxSizing: 'border-box', fontSize: 12, fontFamily: 'inherit',
        color: 'inherit', background: 'transparent', borderRadius: 8, padding: '4px 6px',
        border: '1px solid rgba(127,127,127,0.35)',
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        keys.map((k) => {
          const spec = settings.keys[k] || {}
          const overridden = settings.overrides && settings.overrides[k] !== undefined
          return h(
            'div',
            { key: k, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, flexWrap: 'wrap' } },
            h('div', { style: { width: 220, color: T.textSub } }, `${k}${overridden ? ' *' : ''}`),
            h('input', {
              value: vals[k] === undefined ? '' : String(vals[k]),
              onChange: (e) => setVals({ ...vals, [k]: e.target.value }),
              style: input,
            }),
            h('div', { style: { color: T.textSub, fontSize: 11 } }, `${t('defaultLabel')} ${spec.def}（${spec.min}–${spec.max}）`),
          )
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 } },
          h(Button, { primary: true, disabled: busy, onClick: () => store.act('set-budget', { values: vals }) }, busy ? t('saving') : t('save')),
          h('span', { style: { fontSize: 11, color: T.textSub } }, t('budgetSettingsHint')),
        ),
      )
    }

    function ConfirmBox(props) {
      const { card, store, t } = props
      const [decision, setDecision] = useState('')
      const [detail, setDetail] = useState('')
      const [unhold, setUnhold] = useState(false)
      const busy = store.get().busy === 'confirm'
      const tooShort = decision.trim().length < 8
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 } },
        h('textarea', {
          value: decision,
          rows: 2,
          placeholder: t('confirmDecisionHint'),
          onChange: (e) => setDecision(e.target.value),
          style: confirmInputStyle,
        }),
        h('textarea', {
          value: detail,
          rows: 2,
          placeholder: t('confirmDetailHint'),
          onChange: (e) => setDetail(e.target.value),
          style: confirmInputStyle,
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          card.hold
            ? h(
                'label',
                { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: T.textSub } },
                h('input', {
                  type: 'checkbox',
                  checked: unhold,
                  onChange: (e) => setUnhold(e.target.checked),
                }),
                t('confirmUnhold'),
              )
            : null,
          h(
            Button,
            {
              primary: true,
              disabled: busy || tooShort,
              onClick: () =>
                store
                  .act('confirm', { cardId: card.id, decision, detail, unhold })
                  .then(() => {
                    setDecision('')
                    setDetail('')
                    setUnhold(false)
                  }),
            },
            busy ? t('confirming') : t('confirmGo'),
          ),
          tooShort ? h('span', { style: { fontSize: 11, color: T.textSub } }, t('confirmTooShort')) : null,
        ),
      )
    }

    function Panel(props) {
      const store = props.store
      const snap = useStore(store)
      const t = props.t
      const narrow = useNarrow()
      const data = snap.data || {}
      const [tab, setTab] = useState(() => { try { return localStorage.getItem('ns-tab') || 'todo' } catch { return 'todo' } })
      const goTab = (k) => { setTab(k); try { localStorage.setItem('ns-tab', k) } catch { /* 忽略 */ } }
      const [density, setDensity] = useState(() => { try { return localStorage.getItem('ns-density') || 'comfy' } catch { return 'comfy' } })
      const toggleDensity = () => { const nv = density === 'comfy' ? 'compact' : 'comfy'; setDensity(nv); try { localStorage.setItem('ns-density', nv) } catch { /* 忽略 */ } }

      const chips = []
      if (data.ok || snap.data) {
          data.cost
            ? h(
                Chip,
                { key: 'cost', tone: 'brand' },
                `${t('cost')}: ${data.cost.cny.toFixed(2)} 元 / ${data.cost.runs} 轮`,
              )
            : null,
        chips.push(h(Chip, { key: 'peak', tone: data.peak ? 'warn' : 'ok' },
          data.peak
            ? t('statePeak') + '（跑批暂停）'
            : t('stateOffpeak') + (typeof data.windowLeft === 'number' && data.windowLeft > 0
                ? `（距峰段 ${data.windowLeft >= 3600 ? (data.windowLeft / 3600).toFixed(1) + ' 小时' : Math.round(data.windowLeft / 60) + ' 分钟'}）`
                : '')))
        chips.push(h(Chip, { key: 'run', tone: data.paused ? 'danger' : 'brand' }, data.paused ? t('statePaused') : t('stateRunning')))
        chips.push(
          h(
            Chip,
            { key: 'timer', tone: String(data.timer && data.timer.active).trim() === 'active' ? 'default' : 'danger' },
            `${t('timer')}: ${String((data.timer && data.timer.active) || '?').trim()}`,
          ),
        )
        chips.push(h(Chip, { key: 'next' }, `${t('nextScan')}: ${(data.timer && data.timer.next) || t('none')}`))
        chips.push(
          h(
            Chip,
            { key: 'cool', tone: data.cooldown && data.cooldown.minutesLeft > 0 ? 'default' : 'ok' },
            `${t('cooldown')}: ${data.cooldown && data.cooldown.minutesLeft > 0 ? `${data.cooldown.minutesLeft} ${t('minutes')}` : t('soon')}`,
          ),
        )
        chips.push(
          h(
            Chip,
            { key: 'budget' },
            `${t('budget')}: ${(data.budget && data.budget.cards) || 0}/${(data.budget && data.budget.maxCards) || 8} ${t('cards')} · ${(data.budget && data.budget.minutes) || 0}/${(data.budget && data.budget.maxMinutes) || 120} ${t('minutes')}`,
          ),
        )
      }

      const todos = Array.isArray(data.todos) ? data.todos : []
      const reviews = Array.isArray(data.reviews) ? data.reviews : []
      const running = Array.isArray(data.running) ? data.running : []
      const recent = data.recent || {}
      const setup = data.setup || {}
      const problems = (Array.isArray(data.problems) ? data.problems : []).filter(
        // 「定时器当前是 active」是正常状态，不该显示成提示（旧版宿主会多带一个换行）
        (p) => !/当前是\s*active\b/.test(String(p)),
      )

      // ── 现代仪表盘：四块统计磁贴（今日完成/待跑/待审/花费）+ 运行中横幅
      const stat = (label, value, tone) =>
        h('div', {
          style: {
            flex: '1 1 0', minWidth: narrow ? 0 : 120, background: T.fill, border: `1px solid ${T.borderStrong}`,
            borderRadius: 14, padding: narrow ? '10px 10px' : '12px 14px', display: 'flex', flexDirection: 'column', gap: 2,
          },
        },
          h('div', { style: { fontSize: 11, color: T.textSub, letterSpacing: 0.3 } }, label),
          h('div', { style: { fontSize: narrow ? 20 : 24, fontWeight: 800, color: tone || T.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 } }, value))
      const doneCount = Array.isArray(data.doneToday) ? data.doneToday : null
      const hero = h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        stat('待跑', String(todos.length), T.brand),
        stat('待审', String(reviews.length), reviews.length ? T.warn : null),
        stat(narrow ? '在跑' : '正在跑', String(running.length), running.length ? '#1a8f5a' : null),
        stat('今日花费', data.cost ? `${data.cost.cny.toFixed(2)}元` : '—', null),
        doneCount ? stat('今日完成', String(doneCount.length), '#1a8f5a') : null,
      )
      const runningBanner = running.length
        ? h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 6, background: 'rgba(26,143,90,0.10)', border: '1px solid rgba(26,143,90,0.35)',
              borderRadius: 14, padding: '10px 12px' },
          },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 700, color: '#1a8f5a' } },
            h('span', { style: { width: 9, height: 9, borderRadius: 5, background: '#1a8f5a', boxShadow: '0 0 0 4px rgba(26,143,90,0.18)' } }),
            `正在跑 ${running.length} 张`),
          ...running.slice(0, 3).map((r) =>
            h('div', { key: r.id || r.title, style: { fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              `· ${r.title || r.id}`)),
        )
        : null

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflow: 'auto',
            padding: narrow ? '12px 12px 22px' : '16px 18px 28px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            color: T.text,
            background: T.bg,
            boxSizing: 'border-box',
          },
        },
        h(
          'header',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontSize: 17, fontWeight: 700 } }, t('title')),
          h('div', { style: { fontSize: 12, color: T.textSub } }, t('subtitle')),
          // 看板切换器：面板跟随你选的看板（记住选择）。默认 ops。
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 2 } },
            h('span', { style: { fontSize: 12, color: T.textSub } }, t('boardLabel')),
            ...(Array.isArray(snap.data && snap.data.boards) && snap.data.boards.length
              ? snap.data.boards
              : []
            ).map((b) =>
              h(
                Button,
                {
                  key: `board-${b.key}`,
                  primary: snap.board === b.key,
                  onClick: () => store.setBoard(b.key),
                },
                b.label,
              ),
            ),
            h(
              'span',
              { style: { fontSize: 11, color: T.textSub, wordBreak: 'break-all' } },
              (snap.data && snap.data.board && snap.data.board.path) || '',
            ),
          ),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 } }, chips),
        ),

        setup.configured === false
          ? h(
              'div',
              {
                style: {
                  ...cardStyle, borderColor: T.brand, fontSize: 12, lineHeight: 1.65,
                  display: 'flex', flexDirection: 'column', gap: 6,
                },
              },
              h('div', { style: { fontWeight: 700, fontSize: 13, color: T.text } }, t('setupTitle')),
              h('div', { style: { color: T.textSub } }, t('setupBody')),
              h(
                'code',
                {
                  style: {
                    fontSize: 12, padding: '7px 9px', borderRadius: 8, background: T.fill,
                    border: `1px solid ${T.borderStrong}`, wordBreak: 'break-all',
                  },
                },
                setup.initCommand || 'npx dsh-offhours init --repo .',
              ),
              h('div', { style: { color: T.textSub } }, t('setupAfter')),
              setup.configPath
                ? h('div', { style: { color: T.textSub, wordBreak: 'break-all' } }, `${t('setupConfigPath')} ${setup.configPath}`)
                : null,
            )
          : null,
        snap.error
          ? h('div', { style: { ...cardStyle, borderColor: T.danger, color: T.danger, fontSize: 12 } }, snap.error)
          : null,
        problems.length
          ? h(
              'div',
              { style: { ...cardStyle, fontSize: 12, color: T.warn } },
              `${t('problems')}：${problems.join('；')}`,
            )
          : null,
        hero,
        runningBanner,
        snap.toast ? h('div', { style: { ...cardStyle, fontSize: 12 } }, snap.toast) : null,

        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          reviews.length
            ? h(Button, { primary: true, onClick: () => store.setApprovalOpen(true) }, `${t('openApproval')} (${reviews.length})`)
            : null,
          data.paused
            ? h(Button, { onClick: () => store.act('resume'), disabled: snap.busy === 'resume' }, t('resume'))
            : h(Button, { onClick: () => store.act('pause'), disabled: snap.busy === 'pause' }, t('pause')),
          h(Button, { onClick: () => store.act('scan'), disabled: snap.busy === 'scan' }, t('scanNow')),
          h(
            Button,
            { onClick: () => store.act('scan-now'), disabled: snap.busy === 'scan-now' },
            t('scanNowForced'),
          ),
          h(Button, { onClick: () => store.refresh(), disabled: snap.loading }, t('refresh')),
          data.runningNow && data.runningNow.count > 0
            ? h('div', {
                onClick: () => store.setLiveOpen(true),
                style: { width: '100%', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer', marginTop: 6, padding: '10px 12px', borderRadius: 10, background: 'rgba(26,143,90,0.10)', border: '1px solid rgba(26,143,90,0.55)' },
              },
              h('span', { style: { width: 10, height: 10, borderRadius: 5, background: '#1a8f5a', display: 'inline-block' } }),
              h('div', { style: { fontSize: 13, fontWeight: 700, color: '#1a8f5a' } }, t('runningNowText')),
              h('div', { style: { fontSize: 12, wordBreak: 'break-word' } }, data.runningNow.title || data.runningNow.cardId || ''),
              h('div', { style: { fontSize: 11, color: T.textSub } },
                (data.runningNow.count ? `worker×${data.runningNow.count}` : '') +
                  (data.runningNow.since ? `　已跑 ${Math.max(0, Math.round((Date.now() / 1000 - data.runningNow.since) / 60))} 分钟` : '')),
              h('div', { style: { flex: 1 } }),
              h(Button, { primary: true, onClick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); store.setLiveOpen(true) } }, t('liveOpen')),
            )
            : null,
          h('div', { style: { flex: 1 } }),
          h(
            'span',
            { style: { fontSize: 11, color: T.textSub } },
            `${t('lastRefresh')}: ${snap.at ? snap.at.toLocaleTimeString() : '—'}`,
          ),
        ),

        snap.loading && !snap.data
          ? h('div', { style: { fontSize: 12, color: T.textSub } }, t('loading'))
          : null,

        h('div', {
          role: 'tablist',
          style: { display: 'flex', gap: 6, alignItems: 'stretch', position: 'sticky', top: 0, zIndex: 6, background: T.bg,
            paddingTop: 2, paddingBottom: 6, borderBottom: `1px solid ${T.borderStrong}` },
        },
          ...[
            { k: 'todo', label: t('todo'), n: todos.length, tone: T.brand },
            { k: 'review', label: t('review'), n: reviews.length, tone: reviews.length ? T.warn : T.textSub },
            { k: 'live', label: t('running'), n: running.length, tone: running.length ? '#1a8f5a' : T.textSub },
            { k: 'doc', label: '手册', n: 0, tone: T.textSub },
            { k: 'timers', label: '定时', n: (data.cron || []).length + 2, tone: T.textSub },
          ].map((x) => h('button', {
            key: x.k, role: 'tab', 'aria-selected': tab === x.k, onClick: () => goTab(x.k),
            style: { flex: '1 1 0', minHeight: narrow ? 44 : 36, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: narrow ? 13 : 12.5, fontWeight: 700,
              border: `1px solid ${tab === x.k ? x.tone : T.borderStrong}`,
              background: tab === x.k ? 'rgba(127,127,127,0.10)' : 'transparent',
              color: tab === x.k ? x.tone : T.textSub },
          }, x.label, h('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 9,
            background: tab === x.k ? x.tone : T.fill, color: tab === x.k ? '#fff' : T.textSub } }, String(x.n)))),
          h('button', { onClick: toggleDensity, title: density === 'comfy' ? '切换紧凑' : '切换舒适',
            style: { minWidth: narrow ? 44 : 36, minHeight: narrow ? 44 : 36, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 12, border: `1px solid ${T.borderStrong}`, background: 'transparent', color: T.textSub } },
            density === 'comfy' ? '⌄' : '⌃'),
        ),

        tab === 'todo'
          ? h(Section, { title: t('todo'), count: todos.length, extra: (data.runningNow && data.runningNow.count > 0) ? h(Chip, { tone: 'ok' }, `${t('runningNowText')}`) : null },
              todos.length === 0
                ? h('div', { style: { fontSize: 12, color: T.textSub } }, t('emptyTodo'))
                : h(TodoQueue, { todos, store, t, runningNow: data.runningNow, density }))
          : null,

        tab === 'review'
          ? h(Section, { title: t('review'), count: reviews.length },
              reviews.length === 0
                ? h('div', { style: { fontSize: 12, color: T.textSub } }, t('emptyReview'))
                : reviews.map((c) => h(Row, { key: c.id, title: c.title,
                    meta: [c.decision ? h(Chip, { key: 'd', tone: 'warn' }, t('needsDecision')) : null, c.hold ? h(Chip, { key: 'h', tone: 'danger' }, t('hold')) : null].filter(Boolean),
                    body: [c.note ? h('div', { style: { fontSize: 12, color: T.textSub, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: T.fill, borderRadius: 8, padding: '8px 10px', maxHeight: 220, overflow: 'auto' } }, c.note) : null,
                      h(ConfirmBox, { key: 'confirm', card: c, store, t })] })))
          : null,

        tab === 'timers'
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 } },
              h('div', { style: { fontSize: 14, fontWeight: 700 } }, `夜间跑批（systemd 定时）· ${(data.timers || []).length || 2} 个单元`),
              ...((data.timers && data.timers.length) ? data.timers : [
                { unit: 'nightshift.timer', next: '（读不到）', last: '—', activates: 'nightshift.service' },
                { unit: 'nightshift-hemou.timer', next: '（读不到）', last: '—', activates: 'nightshift-hemou.service' },
              ]).map((tm) => h('div', { key: tm.unit, style: { padding: '8px 10px', border: `1px solid ${T.borderStrong}`, borderRadius: 10 } },
                h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, tm.unit),
                h('div', { style: { fontSize: 11, color: T.textSub } }, `下次 ${tm.next || '—'} · 上次 ${tm.last || '—'} → ${tm.activates || ''}`))),
              h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
                h(Button, { onClick: () => store.act('pause'), disabled: snap.busy === 'pause' }, t('pause')),
                h(Button, { onClick: () => store.act('resume'), disabled: snap.busy === 'resume' }, t('resume'))),
              h('div', { style: { fontSize: 14, fontWeight: 700, marginTop: 6 } }, `Agent 定时任务（cron）· ${(data.cron || []).length} 条`),
              (data.cron || []).length === 0
                ? h('div', { style: { fontSize: 12, color: T.textSub } }, '没有 agent 定时任务')
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    ...(data.cron || []).slice(0, 20).map((j) => h('div', { key: j.id, style: { padding: '8px 10px', border: `1px solid ${T.borderStrong}`, borderRadius: 10, background: j.looksLikeNightshift ? 'rgba(200,60,40,0.06)' : T.bg } },
                      h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                        h('span', { style: { fontSize: 12.5, fontWeight: 600 } }, j.name),
                        j.looksLikeNightshift ? h(Chip, { tone: 'danger' }, '遗留·已由 systemd 取代') : null,
                        h(Chip, { tone: j.enabled ? 'ok' : 'default' }, j.enabled ? '启用' : '未启用')),
                      h('div', { style: { fontSize: 11, color: T.textSub } }, `${j.schedule} · 上次 ${j.lastRunStatus || '—'}`)))),
              h('div', { style: { fontSize: 11, color: T.textSub, marginTop: 4 } }, 'agent 任务由 cron 唤起会话执行；跑批本体走 systemd（零 token）。编辑/删除请在左侧 Automation tasks 里操作。'))
          : null,

        tab === 'doc'
          ? h('div', { style: { height: narrow ? '68vh' : '72vh', borderRadius: 12, overflow: 'hidden', border: `1px solid ${T.borderStrong}`, marginTop: 8 } },
              h('iframe', { src: '/nightshift/api/doc-page', title: '使用手册', style: { width: '100%', height: '100%', border: 0, display: 'block', background: '#fff' } }))
          : null,

        tab === 'live'
          ? h(Section, { title: t('running'), count: running.length },
              running.length === 0
                ? h('div', { style: { fontSize: 12, color: T.textSub } }, t('emptyRunning'))
                : running.map((c) => h(Row, { key: c.id, title: c.title }, null)))
          : null,

        data.settings
          ? h(
              Section,
              { title: t('budgetSettings') },
              h(
                'details',
                null,
                h('summary', { style: { cursor: 'pointer', fontSize: 12, color: T.textSub } }, t('budgetSettingsOpen')),
                h('div', { style: { marginTop: 8 } }, h(BudgetSettings, { settings: data.settings, store, t })),
              ),
            )
          : null,
        h(
          Section,
          { title: t('recent') },
          recent.receipt
            ? h('div', { style: { ...cardStyle, fontSize: 12, wordBreak: 'break-word' } }, recent.receipt)
            : null,
          recent.runs && recent.runs.length
            ? h(
                'div',
                { style: { fontSize: 11, color: T.textSub, fontFamily: mono, wordBreak: 'break-all' } },
                recent.runs.join('  ·  '),
              )
            : null,
          recent.log && recent.log.length
            ? h(
                'pre',
                {
                  style: {
                    margin: 0,
                    padding: '10px 12px',
                    ...cardStyle,
                    fontSize: 11,
                    lineHeight: 1.5,
                    fontFamily: mono,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 260,
                    overflow: 'auto',
                  },
                },
                recent.log.join('\n'),
              )
            : null,
        ),
      )
    }

    /** 使用手册的样式（只用主题 token + 半透明灰，暗色/亮色都不炸）。 */
    const DOC_S = {
      body: { padding: '14px 16px 28px', overflow: 'auto', height: '100%', boxSizing: 'border-box',
        fontSize: 14, lineHeight: 1.7, color: 'var(--dsw-alias-text-primary, inherit)' },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      title: { fontSize: 17, fontWeight: 700 },
      meta: { fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      h1: { fontSize: 18, fontWeight: 700, margin: '20px 0 8px' },
      h2: { fontSize: 15.5, fontWeight: 700, margin: '20px 0 8px', paddingBottom: 4,
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))' },
      h3: { fontSize: 14, fontWeight: 700, margin: '16px 0 6px' },
      p: { margin: '6px 0', wordBreak: 'break-word' },
      quote: { margin: '8px 0', padding: '2px 10px', fontSize: 13, opacity: 0.85,
        borderLeft: '3px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.35))' },
      li: { margin: '3px 0', paddingLeft: 16, textIndent: -12 },
      code: { fontFamily: 'var(--dsw-alias-font-family-mono, ui-monospace, Menlo, monospace)', fontSize: 12.5,
        background: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,0.12))', borderRadius: 4, padding: '1px 4px' },
      pre: { fontFamily: 'var(--dsw-alias-font-family-mono, ui-monospace, Menlo, monospace)', fontSize: 12,
        lineHeight: 1.5, whiteSpace: 'pre', overflowX: 'auto',
        background: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,0.10))',
        borderRadius: 8, padding: '10px 12px', margin: '10px 0' },
      tableWrap: { overflowX: 'auto', margin: '10px 0', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))' },
      table: { borderCollapse: 'collapse', width: '100%', minWidth: 560, fontSize: 13 },
      th: { textAlign: 'left', padding: '7px 10px', fontWeight: 600, whiteSpace: 'nowrap',
        background: 'var(--dsw-alias-fill-secondary, rgba(127,127,127,0.10))',
        borderBottom: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))' },
      td: { padding: '6px 10px', verticalAlign: 'top',
        borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.16))' },
    }

    /** 行内格式：`代码` 与 **加粗**（手册只用到这两种）。 */
    function docInline(text, key) {
      return String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter((x) => x !== '').map((x, i) => {
        if (x.length > 1 && x.startsWith('`') && x.endsWith('`')) return h('code', { key: key + 'c' + i, style: DOC_S.code }, x.slice(1, -1))
        if (x.length > 4 && x.startsWith('**') && x.endsWith('**')) return h('strong', { key: key + 'b' + i }, x.slice(2, -2))
        return x
      })
    }

    /** 极简 markdown → React 节点：标题/表格/列表/代码块/引用/段落（零依赖，够这本手册用）。 */
    function renderDoc(text) {
      const out = []
      let k = 0
      const chunks = String(text).split(/```(?:\w+)?\n?([\s\S]*?)```/g)
      chunks.forEach((chunk, ci) => {
        if (ci % 2 === 1) { out.push(h('pre', { key: 'pre' + ci, style: DOC_S.pre }, chunk.replace(/\n$/, ''))); return }
        const lines = chunk.split('\n')
        let i = 0
        while (i < lines.length) {
          const t = lines[i].trim()
          if (!t) { i += 1; continue }
          const mh = t.match(/^(#{1,3})\s+(.*)$/)
          if (mh) {
            const style = mh[1].length === 1 ? DOC_S.h1 : mh[1].length === 2 ? DOC_S.h2 : DOC_S.h3
            out.push(h('div', { key: 'h' + (k += 1), style }, docInline(mh[2], 'h' + k)))
            i += 1; continue
          }
          if (t.startsWith('>')) {
            out.push(h('div', { key: 'q' + (k += 1), style: DOC_S.quote }, docInline(t.replace(/^>\s?/, ''), 'q' + k)))
            i += 1; continue
          }
          if (t.startsWith('|')) {
            const rows = []
            while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i].trim()), i += 1
            const cells = rows.map((r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
            const body = cells.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''))
            if (body.length) {
              const head = body[0]
              const rest = body.slice(1)
              out.push(h('div', { key: 'tw' + (k += 1), style: DOC_S.tableWrap },
                h('table', { style: DOC_S.table },
                  h('thead', null, h('tr', null, head.map((c, j) => h('th', { key: 'th' + j, style: DOC_S.th }, docInline(c, 'th' + j))))),
                  h('tbody', null, rest.map((r, ri) => h('tr', { key: 'tr' + ri }, r.map((c, j) => h('td', { key: 'td' + j, style: DOC_S.td }, docInline(c, 'td' + ri + '_' + j)))))))))
            }
            continue
          }
          if (/^[-*]\s+/.test(t)) {
            out.push(h('div', { key: 'li' + (k += 1), style: DOC_S.li }, '• ', docInline(t.replace(/^[-*]\s+/, ''), 'li' + k)))
            i += 1; continue
          }
          if (/^\d+[.)]\s+/.test(t)) {
            out.push(h('div', { key: 'ol' + (k += 1), style: DOC_S.li }, docInline(t, 'ol' + k)))
            i += 1; continue
          }
          out.push(h('div', { key: 'p' + (k += 1), style: DOC_S.p }, docInline(t, 'p' + k)))
          i += 1
        }
      })
      return out
    }

    /** 常驻「使用手册」面板：结构化渲染（标题/表格/列表/代码块），手机可横滑，零依赖。 */
    function DocPanel() {
      const [tab, setTab] = useState('doc')
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const load = () => {
        setErr('')
        fetch(API + '/doc', { headers: { 'x-nightshift': '1' } })
          .then((r) => r.json()).then((j) => setData(j || {})).catch((e) => setErr(String(e)))
      }
      useEffect(() => { load() }, [])
      const text = (data && data.text) || ''
      // 图由本机 markdown-docs 服务（:8087，systemd markdown-docs.service）托管；
      // 用当前 hostname 拼 ⇒ 桌面 127.0.0.1 与手机 Tailscale/LAN IP 都能取到。
      const origin = (typeof location !== 'undefined' ? location.protocol : 'http:') + '//'
        + (typeof location !== 'undefined' ? location.hostname : '127.0.0.1') + ':8087'
      const ARTIFACTS = {
        map: { url: origin + '/devloop-skills-map.html', title: 'dev-loop 技能协作地图' },
        round: { url: origin + '/devloop-round.html', title: '一轮 dev-loop 时序图' },
        hemou: { url: origin + '/devloop-hemou-overlay.html', title: 'hemou 项目 overlay：7 个技能在哪个阶段用' },
      }
      const tabBtn = (id, label) => h('button', {
        key: id,
        onClick: () => setTab(id),
        style: {
          fontSize: 12.5, padding: '4px 10px', cursor: 'pointer', borderRadius: 7,
          border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.3))',
          background: tab === id ? 'var(--dsw-alias-fill-secondary, rgba(127,127,127,0.14))' : 'transparent',
          fontWeight: tab === id ? 600 : 400,
        },
      }, label)
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' } },
        h('div', { style: { ...DOC_S.head, padding: '12px 16px 6px', flexWrap: 'wrap' } },
          h('div', { style: DOC_S.title }, '📖 使用手册'),
          tabBtn('doc', '手册'),
          tabBtn('map', '🗺 协作地图'),
          tabBtn('round', '🔁 一轮时序'),
          tabBtn('hemou', '🧩 hemou overlay'),
          tab === 'doc' ? h('button', { onClick: load, style: { fontSize: 12.5, padding: '4px 10px', cursor: 'pointer' } }, '刷新') : null,
          tab === 'doc' && data && data.file ? h('span', { style: DOC_S.meta }, data.file) : null),
        tab !== 'doc'
          ? h('div', { style: { flex: 1, minHeight: 0, padding: '0 12px 12px' } },
            h('iframe', {
              key: tab,
              src: ARTIFACTS[tab].url,
              title: ARTIFACTS[tab].title,
              style: { width: '100%', height: '100%', border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))', borderRadius: 10, background: '#fff' },
            }))
          : h('div', { style: { ...DOC_S.body, height: 'auto', flex: 1, minHeight: 0 } },
            err ? h('div', { style: { color: 'var(--dsw-alias-text-danger, #c0392b)', fontSize: 13 } }, '读取失败：' + err) : null,
            !data ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, '加载中…')
              : !text ? h('div', { style: { fontSize: 13, opacity: 0.7 } }, '手册未部署或为空（请先 ./deploy/install.sh）')
                : renderDoc(text)))
    }

    /** 左侧常驻菜单项「使用手册」：纯图标（点击行为由侧栏完成 —— 切到同名 key 的中央面板）。 */
    function DocSidebarEntry(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('span', {
        'aria-hidden': 'true',
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '100%', height: '100%', fontSize: size, lineHeight: 1 },
      }, '📖')
    }

    const PLUGIN_ID = '@local/dsh-nightshift-panel'
    // 2026-10-29：客户端插件的 apply 一旦抛异常，web 前端会显示「Failed to load plugins」并**整体阻塞**。
    // 一个面板的故障不该拖垮整页：统一降级（面板不可用，其它功能照常），并把原因打到控制台。
    const safeApply = (fn) => function (ctx) {
      try { return fn.call(this, ctx) } catch (e) {
        try {
          console.error('[plugin] 客户端激活失败（已降级，不影响其它功能）', e)
          // 便于事后取证：把失败记到全局，浏览器里 `__dshPluginErrors__` 可直接读
          const g = globalThis
          g.__dshPluginErrors__ = g.__dshPluginErrors__ || []
          g.__dshPluginErrors__.push({ plugin: PLUGIN_ID, message: String(e && e.message || e), stack: String(e && e.stack || '') })
        } catch {}
      }
    }

    return {
      // 'layout' 必须声明：A1 里要读 ctx.layout.panelInfo 判断面板是否激活；
      // 客户端 cordis 对未 inject 的服务是**硬抛错**（cannot get property "layout" without inject）。
      inject: ['slots', 'sessions', 'layout'],
      apply: safeApply(function (ctx) {
        const t = makeDict(ctx)
        const store = createStore()
      /** 用官方的「对话 / 轨迹」窗口打开某个会话（不自己造查看器）。
       *  做法与会话内看板插件一致：先收起本面板，再让 sessions 服务打开该会话。 */
      const openWorkerSession = (sid) => {
        if (!sid) return
        try { ctx.get('layout')?.selectPanel?.(null) } catch { /* 布局服务不可用则直接开会话 */ }
        const sessions = ctx.get('sessions')
        if (sessions && typeof sessions.open === 'function') sessions.open(sid)
      }

        // 30 秒自动刷新：定时器注册在 ctx.effect 里，插件/槽位卸载时随之清理
        // 2026-10-29（A1）：原来只要插件加载就每 120s 拉一次 /status（77KB→gz 21KB），
        // 哪怕从没打开过面板。改为：只有本面板是**当前激活面板**且页面可见时才拉；
        // 面板被切到前台时立刻补一次，保证打开即最新。
        ctx.effect(() => {
          const info = ctx.layout?.panelInfo
          const isActive = () => {
            try { return info?.getSnapshot?.().activePanelId === 'nightshift' } catch { return true }
          }
          const tick = () => {
            if (document.visibilityState === 'visible' && isActive()) store.refresh()
          }
          tick()   // 首次加载仍刷一次（保持原行为：常驻菜单项需要数据）
          const id = setInterval(tick, 120000)
          const unsub = info?.subscribe?.(() => { if (isActive()) store.refresh() })
          return () => { clearInterval(id); unsub?.() }
        })

        // 常驻菜单项：使用手册（独立面板；不塞在按钮行里）
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'nightshift-doc', order: 41, label: '使用手册' }, DocSidebarEntry),
        )

        // 内嵌主面板：与左侧菜单项 id 同名（key=nightshift-doc）
        // `main` 是 keyed 槽，布局按 activePanelId 找同名 key 渲染；点左侧那一行 = selectPanel('nightshift-doc')。
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'nightshift-doc', order: 41 }, () => h(DocPanel)),
        )

        // 左侧图标（id 与中央面板 key 同名 → 点它切到面板）
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'nightshift', order: 40, label: t('title') }, SidebarEntry),
        )

        // 实时输出窗口（浮层；未打开时渲染 null）
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'nightshift-live', order: 61, label: t('liveTitle') }, (slotProps) =>
            h(LiveWindow, { ...slotProps, store, t }),
          ),
        )

        // 审批窗口（浮层；未打开时渲染 null）
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'nightshift-approval', order: 60, label: t('approvalTitle') }, (slotProps) =>
            h(ApprovalWindow, { ...slotProps, store, t }),
          ),
        )

        // 中央面板
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'nightshift', order: 40 }, (slotProps) =>
            h(Panel, { ...slotProps, store, t }),
          ),
        )
      }),
    }
  },
})

