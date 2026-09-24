import {
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Link2 as LinkIcon,
  Loader2,
  X,
  Zap,
} from 'lucide-react'
import { type ChartObjects, createLinkGroup, type LinkGroup } from 'openalgo-charts'
import type { WorkspaceDocument, WorkspacePayload } from 'openalgo-charts/workspace'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navbar } from '@/components/layout/Navbar'
import { showToast } from '@/utils/toast'
import { tradingApi } from '@/api/trading'
import { oiProfileApi } from '@/api/oi-profile'
import { useLiveQuote } from '@/hooks/useLiveQuote'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { useSupportedExchanges } from '@/hooks/useSupportedExchanges'

// Lazy, because the panel pulls the markdown renderer and the syntax
// highlighter's grammars and themes behind it. Statically imported, every
// trader loading a chart paid for a chat they may never open. The heavy
// visualization packages inside it are already lazy for the same reason.
const AgentPanel = lazy(() =>
  import('@/components/trading/AgentPanel').then((m) => ({ default: m.AgentPanel }))
)

import { ChartPane } from '@/components/trading/ChartPane'
import { DrawingRail } from '@/components/trading/DrawingRail'
import { DOCK_ID } from '@/components/trading/dock/DockShell'
import {
  type DockTab,
  escapeTarget,
  readDockTab,
  writeDockTab,
} from '@/components/trading/dock/dockState'
import { TradingDock } from '@/components/trading/dock/TradingDock'
import { IndicatorTemplates } from '@/components/trading/IndicatorTemplates'
import { ObjectsPanel } from '@/components/trading/ObjectsPanel'
import { OptionChainPanel } from '@/components/trading/OptionChainPanel'
import { isPanelId, type PanelId, RightRail } from '@/components/trading/RightRail'
import { TickBox } from '@/components/trading/TickBox'
import { WatchlistPanel } from '@/components/trading/WatchlistPanel'
import { WorkspaceGrid } from '@/components/trading/WorkspaceGrid'
import { WorkspaceMenu } from '@/components/trading/WorkspaceMenu'
import { WorkspaceReplayBar } from '@/components/trading/WorkspaceReplayBar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useChartWorkspaceCatalog } from '@/hooks/useChartWorkspaceCatalog'
import { useWorkspaceAutosave } from '@/hooks/useWorkspaceAutosave'
import { useWorkspaceGridTransition } from '@/hooks/useWorkspaceGridTransition'
import type { AgentChartCommand } from '@/lib/agent/stream'
import { LAYOUTS, LayoutIcon } from '@/lib/chart/layouts'
import { alertRuntimeKey, removeWorkspaceAlertRuntime } from '@/lib/trading/alertRuntime'
import type { PreparedChartGrid } from '@/lib/trading/preparedGrid'
import type { DrawStats, SearchRow, TradingTerminal } from '@/lib/trading/terminal'
import { capturePresetWorkspace } from '@/lib/trading/workspaceGrid'
import {
  WorkspaceReplayCoordinator,
  type WorkspaceReplaySnapshot,
} from '@/lib/trading/workspaceReplay'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { createPortal } from 'react-dom'

const NO_DRAW: DrawStats = {
  count: 0,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  magnet: false,
  stay: false,
  tool: null,
  shortcuts: {},
}

// Same instrument list Positions.tsx uses for its Scalper/Quick Order panel —
// kept in sync so both pages filter to the same broker-supported indexes.
const QO_INSTRUMENTS = [
  { value: 'NIFTY',      optionExchange: 'NFO',    underlyingExchange: 'NSE_INDEX' },
  { value: 'BANKNIFTY',  optionExchange: 'NFO',    underlyingExchange: 'NSE_INDEX' },
  { value: 'FINNIFTY',   optionExchange: 'NFO',    underlyingExchange: 'NSE_INDEX' },
  { value: 'MIDCPNIFTY', optionExchange: 'NFO',    underlyingExchange: 'NSE_INDEX' },
  { value: 'NIFTYNXT50', optionExchange: 'NFO',    underlyingExchange: 'NSE_INDEX' },
  { value: 'SENSEX',     optionExchange: 'BFO',    underlyingExchange: 'BSE_INDEX' },
  { value: 'BANKEX',     optionExchange: 'BFO',    underlyingExchange: 'BSE_INDEX' },
  { value: 'SENSEX50',   optionExchange: 'BFO',    underlyingExchange: 'BSE_INDEX' },
  { value: 'BTC',        optionExchange: 'CRYPTO', underlyingExchange: 'CRYPTO' },
  { value: 'ETH',        optionExchange: 'CRYPTO', underlyingExchange: 'CRYPTO' },
  { value: 'SOL',        optionExchange: 'CRYPTO', underlyingExchange: 'CRYPTO' },
  { value: 'BNB',        optionExchange: 'CRYPTO', underlyingExchange: 'CRYPTO' },
  { value: 'XRP',        optionExchange: 'CRYPTO', underlyingExchange: 'CRYPTO' },
] as const

type QoUnderlying = (typeof QO_INSTRUMENTS)[number]['value']

function roundToTick(price: number, tickSize = 0.05) {
  return Math.round(price / tickSize) * tickSize
}

// Same shape and endpoint Positions.tsx uses — saving here directly means
// SL/Trail set from the Scalper on this page persist regardless of whether
// the Positions page happens to be open anywhere else.
interface PositionProtection {
  sl_price?: number
  target_price?: number
  trailing_points?: number
  best_price?: number
  current_sl?: number
  status?: 'ACTIVE' | 'TRIGGERED' | 'CLOSED'
  break_even_activated?: boolean
}

async function saveProtectionToServer(key: string, protection: PositionProtection): Promise<void> {
  try {
    await fetch('/api/protection/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key, protection }),
    })
  } catch (err) {
    console.error('Protection save failed', err)
  }
}

const LAYOUT_KEY = 'oa-trading-layout'
const SYNC_KEY = 'oa-trading-sync'
const PANEL_KEY = 'oa-trading-panel'
/**
 * One-Click, the scalping terminal's convention ('1' / '0'). Off by default
 * and off whenever the key is unreadable: a chart must never open with its
 * Buy button live because storage was cleared or blocked.
 */
const ARMED_KEY = 'oa-trading-armed'

function readArmed(): boolean {
  try {
    return localStorage.getItem(ARMED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * What a linked grid agrees on. The engine keeps the three independent, so the
 * control does too: a trader watching one instrument across four timeframes
 * wants crosshair and time linked and the symbol emphatically not, while a
 * sector grid wants the opposite.
 *
 * Crosshair and time default on and symbol defaults off, which is the reading
 * that never surprises: linking the pointer costs nothing, and silently
 * replacing the instrument in three panes because you changed one is a bad way
 * to learn a feature exists. With a single pane a group of one does nothing, so
 * the defaults are invisible until a grid makes them useful.
 */
interface SyncState {
  crosshair: boolean
  viewport: boolean
  symbol: boolean
  interval: boolean
}
const SYNC_DEFAULT: SyncState = { crosshair: true, viewport: true, symbol: false, interval: false }

function readSync(): SyncState {
  try {
    const raw = localStorage.getItem(SYNC_KEY)
    if (!raw) return SYNC_DEFAULT
    const p = JSON.parse(raw) as Partial<SyncState>
    return {
      crosshair: p.crosshair ?? SYNC_DEFAULT.crosshair,
      viewport: p.viewport ?? SYNC_DEFAULT.viewport,
      symbol: p.symbol ?? SYNC_DEFAULT.symbol,
      interval: p.interval ?? SYNC_DEFAULT.interval,
    }
  } catch {
    return SYNC_DEFAULT
  }
}

export default function Trading() {
  const account = useAuthStore((state) =>
    state.isAuthenticated ? (state.user?.username ?? null) : null
  )
  return <TradingWorkspace key={account ?? 'signed-out'} account={account} />
}

function TradingWorkspace({ account }: { account: string | null }) {
  const workspaceCatalog = useChartWorkspaceCatalog(account)
  const workspacePending = useRef(false)
  const visibleGrid = useRef<PreparedChartGrid | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const savedWorkspaceSnapshot = useRef<WorkspacePayload | undefined>(undefined)
  const [workspaceMessage, setWorkspaceMessage] = useState('Unsaved')
  const [saveStamp, setSaveStamp] = useState(0)
  const restoreAttempted = useRef(false)
  const [layoutId, setLayoutId] = useState(() => {
    const saved = localStorage.getItem(LAYOUT_KEY)
    return LAYOUTS.some((l) => l.id === saved) ? (saved as string) : 'single'
  })
  const [sync, setSync] = useState<SyncState>(readSync)
  /**
   * One-Click for the whole workspace. Every pane follows it, like sync: the
   * on-chart Buy in one pane must not fire while the same button in the next
   * pane asks first.
   */
  const [armed, setArmed] = useState<boolean>(readArmed)
  /**
   * One group for the whole workspace, created once and kept for the life of
   * the page. Panes join it as their charts are built and re-join after every
   * rebuild, so changing a layout, theme or chart type does not quietly drop a
   * pane out of the group it still thinks it belongs to.
   */
  const [linkGroup, setLinkGroup] = useState<LinkGroup | null>(null)

  /* ── scalper floating panel ───────────────────────────────────────────── */
  const [scalperOpen, setScalperOpen] = useState(false)
  const [scalperMode, setScalperMode] = useState<0 | 1>(0)
  const [scalperOffset, setScalperOffset] = useState(0)
  const [scalperLots, setScalperLots] = useState(1)
  const [scalperDefaultSL, setScalperDefaultSL] = useState(2)
  const [scalperDefaultTrail, setScalperDefaultTrail] = useState(2)
  const [scalperIsPlacing, setScalperIsPlacing] = useState(false)
  const [scalperZIndex, setScalperZIndex] = useState(1001)
  const scalperDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const scalperElRef = useRef<HTMLDivElement | null>(null)

  const [apiKey, setApiKey] = useState<string | null>(null)
  const [wsUrl, setWsUrl] = useState<string | null>(null)
  const [noApiKey, setNoApiKey] = useState(false)

  // Filter to whatever the connected broker actually supports — this is what
  // was missing before, which is why the dropdown listed every index/crypto
  // regardless of the account's F&O permissions.
  const { fnoExchanges } = useSupportedExchanges()
  const qoOptions = useMemo(
    () => QO_INSTRUMENTS.filter((instrument) =>
      fnoExchanges.some((exchange) => exchange.value === instrument.optionExchange)
    ),
    [fnoExchanges]
  )
  const [scalperIndex, setScalperIndex] = useState<QoUnderlying>('NIFTY')
  const qoInstrument = QO_INSTRUMENTS.find((instrument) => instrument.value === scalperIndex) ?? QO_INSTRUMENTS[0]
  const qoExchange = qoInstrument.optionExchange

  useEffect(() => {
    if (qoOptions.length > 0 && !qoOptions.some((instrument) => instrument.value === scalperIndex)) {
      setScalperIndex(qoOptions[0].value)
    }
  }, [qoOptions, scalperIndex])

  // Start enabled immediately if the tab is already visible — avoids a full
  // render cycle before the live-quote hooks below activate.
  const { isVisible } = usePageVisibility()
  const [wsEnabled, setWsEnabled] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'visible'
  )
  useEffect(() => { setWsEnabled(isVisible) }, [isVisible])

  const [qoExpiry, setQoExpiry] = useState('')
  const [qoStrikeList, setQoStrikeList] = useState<{
    strike: number
    ceSym: string; peSym: string
    ceLotSize: number; peLotSize: number
    ceTickSize: number; peTickSize: number
  }[]>([])
  const [qoAtmIndex, setQoAtmIndex] = useState(0)

  // ── Fetch expiries for the selected underlying ───────────────────────────
  useEffect(() => {
    if (!scalperIndex) return
    let cancelled = false
    const load = async () => {
      try {
        const res = await oiProfileApi.getExpiries(qoInstrument.optionExchange, scalperIndex)
        if (cancelled) return
        if (res.status === 'success' && res.expiries.length > 0) {
          const todayStr = new Date().toISOString().slice(0, 10)
          const monthMap: Record<string, string> = {
            JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
            JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
          }
          const future = res.expiries.filter((e: string) => {
            const parts = e.split('-')
            if (parts.length !== 3) return true
            const mm = monthMap[parts[1].toUpperCase()] ?? '01'
            const yy = parts[2].length === 2 ? `20${parts[2]}` : parts[2]
            const iso = `${yy}-${mm}-${parts[0].padStart(2, '0')}`
            return iso >= todayStr
          })
          const valid = future.length > 0 ? future : res.expiries
          setQoExpiry((prev) => (valid.includes(prev) ? prev : valid[0]))
        }
      } catch (_e) { /* silent */ }
    }
    load()
    return () => { cancelled = true }
  }, [scalperIndex, qoInstrument.optionExchange])

  const convertExpiryForQO = useCallback((expiry: string) => {
    if (!expiry) return ''
    const parts = expiry.split('-')
    if (parts.length === 3) return `${parts[0]}${parts[1].toUpperCase()}${parts[2].slice(-2)}`
    return expiry.replace(/-/g, '').toUpperCase()
  }, [])

  // ── Fetch option chain — this is what drives the real strike/LTP data ────
  useEffect(() => {
    if (!qoExpiry || !scalperIndex || !apiKey) return
    setQoStrikeList([])
    setScalperOffset(0) // reset scalper offset on chain reload
    const underlyingExchange = qoInstrument.underlyingExchange
    let cancelled = false
    const fetchChain = async () => {
      try {
        const expiry = convertExpiryForQO(qoExpiry)
        const res = await fetch('/api/v1/optionchain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apikey: apiKey, underlying: scalperIndex, exchange: underlyingExchange,
            expiry_date: expiry, strike_count: 10,
          }),
        })
        if (!res.ok || cancelled) return
        const json = await res.json()
        if (json?.status !== 'success') return
        const chain = json?.chain ?? []
        if (!chain.length) return
        const mapped = chain.map((s: any) => ({
          strike: s.strike,
          ceSym: s.ce?.symbol ?? '', peSym: s.pe?.symbol ?? '',
          ceLotSize: s.ce?.lotsize ?? 1, peLotSize: s.pe?.lotsize ?? 1,
          ceTickSize: s.ce?.tick_size ?? 0.05, peTickSize: s.pe?.tick_size ?? 0.05,
        }))
        const spot = json?.underlying_ltp ?? 0
        let atmIdx = 0
        let minDiff = Infinity
        mapped.forEach((s: any, i: number) => {
          const d = Math.abs(s.strike - spot)
          if (d < minDiff) { minDiff = d; atmIdx = i }
        })
        if (cancelled) return
        setQoStrikeList(mapped)
        setQoAtmIndex(atmIdx)
      } catch (_e) { /* silent */ }
    }
    fetchChain()
    return () => { cancelled = true }
  }, [scalperIndex, qoExpiry, apiKey, convertExpiryForQO, qoInstrument.underlyingExchange])

  // Derive the scalper's current row from the chain — this replaces the old
  // hardcoded strike/LTP and is what makes the Up/Down (strike) buttons work.
  const scalperRowIndex = Math.max(0, Math.min(qoStrikeList.length - 1, qoAtmIndex + scalperOffset))
  const scalperRow = qoStrikeList[scalperRowIndex]
  const scalperSymbol = scalperMode === 0 ? (scalperRow?.ceSym ?? '') : (scalperRow?.peSym ?? '')
  const scalperLotSize = scalperMode === 0 ? (scalperRow?.ceLotSize ?? 1) : (scalperRow?.peLotSize ?? 1)
  const scalperTickSize = scalperMode === 0 ? (scalperRow?.ceTickSize ?? 0.05) : (scalperRow?.peTickSize ?? 0.05)
  const scalperStrike = scalperRow?.strike ?? null

  const { data: scalperCeData } = useLiveQuote(scalperRow?.ceSym ?? '', qoExchange, {
    enabled: wsEnabled && scalperOpen && scalperMode === 0 && !!scalperRow?.ceSym,
    mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  const { data: scalperPeData } = useLiveQuote(scalperRow?.peSym ?? '', qoExchange, {
    enabled: wsEnabled && scalperOpen && scalperMode === 1 && !!scalperRow?.peSym,
    mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  // This is what makes the LTP update live — before, it was a hardcoded 246.78.
  const scalperLtp = scalperMode === 0 ? (scalperCeData.ltp ?? null) : (scalperPeData.ltp ?? null)

  const { data: scalperUnderlyingData } = useLiveQuote(scalperIndex, qoInstrument.underlyingExchange, {
    enabled: wsEnabled && scalperOpen && !!scalperIndex, mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  const scalperUnderlyingLtp = scalperUnderlyingData.ltp ?? null

  // ── Scalper: places a real market order via the trading API ──────────────
  const handleScalperOrder = useCallback(async (action: 'BUY' | 'SELL') => {
    if (!scalperSymbol || !apiKey || scalperIsPlacing) return
    setScalperIsPlacing(true)
    const qty = scalperLots * scalperLotSize
    try {
      const response = await tradingApi.placeOrder({
        apikey: apiKey,
        strategy: '',
        symbol: scalperSymbol,
        exchange: qoExchange,
        action,
        product: 'NRML',
        pricetype: 'MARKET',
        quantity: qty,
        price: 0,
        trigger_price: 0,
      })
      if (response.status !== 'success') {
        showToast.error(`Scalper order failed: ${response.message ?? 'Unknown error'}`)
        return
      }
      showToast.success(`${action} ${qty} \u00d7 ${scalperSymbol} sent \u2713`)

      // Persist SL/Trail directly — this is the real fix, since the
      // protection-created event only helps if Positions.tsx (or some other
      // listener) is mounted at the same time.
      const ltp = scalperLtp
      if (ltp != null && (scalperDefaultSL > 0 || scalperDefaultTrail > 0)) {
        const isLong = action === 'BUY'
        const slPrice = scalperDefaultSL > 0
          ? roundToTick(isLong ? ltp - scalperDefaultSL : ltp + scalperDefaultSL, scalperTickSize)
          : undefined

        const protection: PositionProtection = {
          status: 'ACTIVE',
          break_even_activated: false,
        }
        if (slPrice !== undefined) { protection.sl_price = slPrice; protection.current_sl = slPrice }
        if (scalperDefaultTrail > 0) protection.trailing_points = scalperDefaultTrail

        const key = `${scalperSymbol}_${qoExchange}_NRML`

        // Fire the event too, in case Positions.tsx is mounted elsewhere and
        // wants to reflect it optimistically without waiting on a poll.
        window.dispatchEvent(new CustomEvent('protection-created', {
          detail: {
            symbol: scalperSymbol,
            exchange: qoExchange,
            product: 'NRML',
            sl_price: slPrice ?? null,
            target_price: null,
            trailing_points: scalperDefaultTrail > 0 ? scalperDefaultTrail : null,
          },
        }))

        // Don't await — keep the UI snappy, same as Positions.tsx.
        saveProtectionToServer(key, protection).catch((err) =>
          console.error('Scalper protection save failed', err)
        )
      }
    } catch (err) {
      console.error('Scalper order error', err)
      showToast.error('Scalper order failed \u2014 see console')
    } finally {
      setScalperIsPlacing(false)
    }
  }, [
    scalperSymbol, scalperLots, scalperLotSize, scalperTickSize,
    scalperLtp, scalperDefaultSL, scalperDefaultTrail,
    qoExchange, apiKey, scalperIsPlacing,
  ])

  /* ── one drawing rail for every pane ─────────────────────────────────── */
  const [tool, setTool] = useState<string | null>(null)
  const [magnet, setMagnet] = useState(false)
  const [stay, setStay] = useState(false)
  const [showRail, setShowRail] = useState(true)
  const [stats, setStats] = useState<DrawStats>(NO_DRAW)
  // Undo / delete act on the pane you last drew in; arming a tool hits them all,
  // so whichever pane you click next is the one that gets the shape.
  const activeRef = useRef<TradingTerminal | null>(null)

  /* ── side panels ─────────────────────────────────────────────────────── */
  const [panel, setPanel] = useState<PanelId | null>(() => {
    const saved = localStorage.getItem(PANEL_KEY)
    // Checked against the rail's own list rather than a second copy of it, so
    // a panel added or renamed there cannot leave this reading a stale name.
    return isPanelId(saved) ? saved : null
  })
  /**
   * The bottom dock: which book is open under the grid, or null for the
   * collapsed strip. Page-level like the side panels, and for the same
   * reason: the books span every symbol, so they belong to no one pane.
   */
  const [dock, setDock] = useState<DockTab | null>(readDockTab)
  /**
   * Which pane a panel click loads into, and whose instrument the watchlist
   * highlights. The first pane until the user touches another, so a click in
   * the panel does something sensible before any pane has been focused.
   */
  const [focusedPane, setFocusedPane] = useState('p0')
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  const [paneSymbols, setPaneSymbols] = useState<Record<string, string | null>>({})
  const [paneObjects, setPaneObjects] = useState<Record<string, ChartObjects>>({})
  /**
   * Every live pane's terminal, keyed by pane id.
   *
   * activeRef alone is not enough: it is only set once the user has clicked
   * into a pane, so on a fresh page load the panels had nothing to act on and
   * their search returned no results at all. This is populated as each pane
   * builds, so the panels work from the first paint.
   */
  const terminalsRef = useRef<Record<string, TradingTerminal | null>>({})
  const layoutIdRef = useRef(layoutId)
  layoutIdRef.current = layoutId
  const replayCoordinator = useRef<WorkspaceReplayCoordinator | null>(null)
  const [replaySnapshot, setReplaySnapshot] = useState<WorkspaceReplaySnapshot>({
    phase: 'idle',
    scope: 'focused',
    ownerId: null,
    state: null,
  })
  const replaySnapshotRef = useRef(replaySnapshot)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [confirmReplayExit, setConfirmReplayExit] = useState(false)
  const replayPaneIds = useCallback(
    () =>
      visibleGrid.current
        ? visibleGrid.current.payload.panes.map((pane) => pane.id)
        : (LAYOUTS.find((item) => item.id === layoutIdRef.current) ?? LAYOUTS[0]).cells.map(
            (_, index) => `p${index}`
          ),
    []
  )
  const updateReplayMembers = useCallback(() => {
    replayCoordinator.current?.setMembers(
      replayPaneIds().flatMap((id) => {
        const terminal = terminalsRef.current[id]
        return terminal ? [{ id, terminal }] : []
      })
    )
  }, [replayPaneIds])
  useEffect(() => {
    let current = true
    const coordinator = new WorkspaceReplayCoordinator({
      onChange: (snapshot) => {
        replaySnapshotRef.current = snapshot
        if (current) {
          setReplaySnapshot(snapshot)
          if (snapshot.phase !== 'active') setConfirmReplayExit(false)
        }
      },
      onError: (error) => {
        if (current)
          setReplayError(error instanceof Error ? error.message : 'Unable to replay this workspace')
      },
    })
    replayCoordinator.current = coordinator
    updateReplayMembers()
    return () => {
      current = false
      coordinator.destroy()
      if (replayCoordinator.current === coordinator) replayCoordinator.current = null
    }
  }, [updateReplayMembers])
  const stopWorkspaceReplay = useCallback(() => {
    setConfirmReplayExit(false)
    replayCoordinator.current?.stop()
  }, [])
  const requestReplayExit = useCallback(() => {
    if (replaySnapshotRef.current.phase === 'active') setConfirmReplayExit(true)
    else stopWorkspaceReplay()
  }, [stopWorkspaceReplay])
  const startWorkspaceReplay = useCallback(
    (paneId: string) => {
      if (workspacePending.current) return
      setReplayError(null)
      const coordinator = replayCoordinator.current
      if (!coordinator) return
      if (coordinator.state().phase !== 'idle') requestReplayExit()
      else {
        if (replayPaneIds().some((id) => !terminalsRef.current[id])) {
          setReplayError('Every visible chart must be ready before replay')
          return
        }
        updateReplayMembers()
        coordinator.start(paneId)
      }
    },
    [replayPaneIds, requestReplayExit, updateReplayMembers]
  )

  const noteTerminal = useCallback(
    (paneId: string, terminal: TradingTerminal | null) => {
      if (visibleGrid.current) return
      if (terminal) terminalsRef.current[paneId] = terminal
      else {
        if (activeRef.current === terminalsRef.current[paneId]) activeRef.current = null
        delete terminalsRef.current[paneId]
      }
      updateReplayMembers()
    },
    [updateReplayMembers]
  )

  const noteObjects = useCallback((paneId: string, objects: ChartObjects | null) => {
    setPaneObjects((previous) => {
      if (objects) {
        if (previous[paneId] === objects) return previous
        return { ...previous, [paneId]: objects }
      }
      if (!(paneId in previous)) return previous
      const next = { ...previous }
      delete next[paneId]
      return next
    })
  }, [])

  /** The pane a panel acts on: the focused one, else any pane that is up. */
  const panelTarget = useCallback(
    () =>
      workspacePending.current
        ? null
        : (terminalsRef.current[focusedPane] ??
          activeRef.current ??
          Object.values(terminalsRef.current)[0] ??
          null),
    [focusedPane]
  )

  const focusPane = useCallback((t: TradingTerminal | null, paneId?: string) => {
    if (workspacePending.current) return
    activeRef.current = t
    if (visibleGrid.current && t) {
      setMagnet(t.drawStats().magnet)
      setStay(t.drawStats().stay)
    }
    if (paneId) setFocusedPane(paneId)
    if (t) setStats(t.drawStats())
  }, [])

  const noteSymbol = useCallback((paneId: string, key: string | null) => {
    setPaneSymbols((prev) => (prev[paneId] === key ? prev : { ...prev, [paneId]: key }))
  }, [])

  /**
   * Load an instrument chosen in a side panel.
   *
   * Panels are page-level and panes are not, so the click has to be routed to
   * one. It goes to the pane the user last touched -- the same pane the drawing
   * rail acts on, so "the pane I am working in" means one thing everywhere.
   */
  const sendToFocusedPane = useCallback(
    (row: SearchRow) => {
      stopWorkspaceReplay()
      void panelTarget()?.loadSymbol(row)
    },
    [panelTarget, stopWorkspaceReplay]
  )

  /**
   * Whether any pane is replaying, or picking a bar to replay from. The
   * dock's actions go to the broker at the live price, and the chart already
   * refuses every order route while a replayed session is on screen; a
   * Cancel in the dock under that chart has to refuse in the same breath.
   * Any pane, not just the focused one: the dock is page-level and the
   * replayed chart is on screen whichever pane it is in.
   */
  const tradingLocked = useCallback(
    () =>
      workspacePending.current ||
      replaySnapshotRef.current.phase !== 'idle' ||
      Object.values(terminalsRef.current).some(
        (t) =>
          t !== null &&
          (t.replayActive() ||
            t.replayPickingBar() ||
            t.replayLoadingBars() ||
            t.dataUnavailable() ||
            t.alertDialogOpen())
      ),
    []
  )

  /** Bound to the focused pane so panel search returns broker-supported rows. */
  const searchFromFocusedPane = useCallback(
    (query: string, exchange?: string, limit?: number) =>
      panelTarget()?.search(query, exchange, limit) ?? Promise.resolve([]),
    [panelTarget]
  )

  /**
   * The agent's two ends, both resolved through `panelTarget` at call time.
   *
   * That is what makes the chart context fresh: the pane is looked up when the
   * message is sent, not when the panel mounted, so loading a symbol and then
   * asking about it asks about the symbol that is there. It also means the
   * agent follows the focused pane in a grid layout, the same way the
   * watchlist and the option chain already do.
   */
  const readChartContext = useCallback(() => panelTarget()?.chartContext() ?? null, [panelTarget])

  const applyChartCommands = useCallback(
    (commands: AgentChartCommand[]) => {
      stopWorkspaceReplay()
      void panelTarget()?.applyChartCommands(commands)
    },
    [panelTarget, stopWorkspaceReplay]
  )

  /**
   * The focused pane as a PNG, for the agent composer's screenshot item.
   *
   * The same capture the camera menu's save and copy use, so what the model is
   * shown is exactly what saving would have produced: the interaction-only
   * overlays taken down, the OHLC readout painted in.
   */
  const captureChart = useCallback(
    () => panelTarget()?.snapshotPng() ?? Promise.resolve(null),
    [panelTarget]
  )
  const objectsPaneId = paneObjects[focusedPane]
    ? focusedPane
    : (Object.keys(paneObjects)[0] ?? focusedPane)
  const objectsPaneNumber = visibleGrid.current
    ? visibleGrid.current.payload.panes.findIndex((pane) => pane.id === objectsPaneId) + 1
    : Number(objectsPaneId.slice(1)) + 1
  const objectsPaneLabel = `Pane ${objectsPaneNumber}${
    paneSymbols[objectsPaneId] ? ` · ${paneSymbols[objectsPaneId]}` : ''
  }`
  const railStats: DrawStats = { ...stats, tool, magnet, stay }
  /**
   * Hand a key event to the focused pane; it reports whether the drawing tier
   * claimed it, as a chord arming a tool or as an edit of the selection
   * (delete, duplicate, a nudge). Both tables ship with the lazily loaded
   * tier, so the terminal -- not this page and not the rail -- can answer.
   */
  const onDrawKey = useCallback((e: KeyboardEvent) => {
    if (workspacePending.current) return false
    const t = activeRef.current
    if (!t || !t.handleDrawKey(e)) return false
    setTool(t.drawStats().tool)
    setStats(t.drawStats())
    return true
  }, [])

  const act = (fn: (t: TradingTerminal) => void) => {
    if (workspacePending.current) return
    const t = activeRef.current
    if (!t) return
    fn(t)
    setStats(t.drawStats())
  }

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layoutId)
  }, [layoutId])

  useEffect(() => {
    if (panel) localStorage.setItem(PANEL_KEY, panel)
    else localStorage.removeItem(PANEL_KEY)
  }, [panel])

  useEffect(() => {
    writeDockTab(dock)
  }, [dock])

  useEffect(() => {
    try {
      localStorage.setItem(ARMED_KEY, armed ? '1' : '0')
    } catch {
      // Storage refused (private mode, quota): the switch still works for
      // this visit, it just does not survive a reload.
    }
  }, [armed])

  /**
   * Escape closes the open panel, the way it disarms a drawing tool. Without
   * it the only way back to a full-width chart is a 32px target in the corner.
   *
   * Closing the panel is the LAST thing Escape should do, so this yields twice:
   *
   * - to any open Radix surface. Checking only the scroll lock and role=dialog
   *   missed the non-modal ones: the option chain's underlying combobox is a
   *   Popover, which sets neither, so dismissing the search closed the whole
   *   panel underneath it.
   * - to an armed drawing tool, which DrawingRail disarms on the same key
   *   without stopping propagation. One Escape did both.
   *
   * The bottom dock slots in after those two and before the panel, but only
   * while it is the topmost thing with focus: focus is inside it, or it is
   * the only thing open. escapeTarget holds that rule.
   */
  useEffect(() => {
    if (!panel && !dock) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (tool) return
      // Never steal Escape from a field, the way DrawingRail does not.
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return
      }
      if (document.body.hasAttribute('data-scroll-locked')) return
      if (
        document.querySelector(
          '[data-trading-dialog-open="true"],' +
            '[data-state="open"][role="dialog"],' +
            '[data-state="open"][data-slot="popover-content"],' +
            '[data-state="open"][role="menu"],' +
            '[data-state="open"][role="listbox"]'
        )
      ) {
        return
      }
      const dockEl = document.getElementById(DOCK_ID)
      const closes = escapeTarget({
        dock: dock !== null,
        panel: panel !== null,
        focusInDock: !!dockEl && dockEl.contains(document.activeElement),
      })
      if (closes === 'dock') setDock(null)
      else if (closes === 'panel') setPanel(null)
    }
    // Capture sees an open pane dialog before that dialog's own window-level
    // Escape listener unmounts it. In bubble order the dialog could disappear
    // first, making this handler also close the panel underneath it.
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [panel, dock, tool])

  useEffect(() => {
    localStorage.setItem(SYNC_KEY, JSON.stringify(sync))
    // setOptions, not a rebuild: the engine clears the linked crosshairs when
    // that switch goes off and converges the group on its agreed symbol when
    // the symbol switch comes on, neither of which a fresh group would do.
    linkGroup?.setOptions(sync)
    visibleGrid.current?.linkGroup.setOptions(sync)
  }, [sync, linkGroup])

  useEffect(() => {
    // Setup owns the group so an effect restart cannot reuse a destroyed one.
    const group = createLinkGroup()
    setLinkGroup(group)
    return () => group.destroy()
  }, [])

  // Fetch the API key + WS URL once; every pane shares them.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [keyRes, cfgRes] = await Promise.all([
          fetch('/api/websocket/apikey').then((r) => r.json()),
          fetch('/api/websocket/config').then((r) => r.json()),
        ])
        if (!alive) return
        if (keyRes.status !== 'success') {
          setNoApiKey(true)
          return
        }
        setApiKey(keyRes.api_key)
        setWsUrl(cfgRes.websocket_url || 'ws://127.0.0.1:8765')
      } catch {
        if (alive) setNoApiKey(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const layout = LAYOUTS.find((l) => l.id === layoutId) ?? LAYOUTS[0]

  const lockWorkspace = useCallback(
    (pending: boolean) => {
      if (pending) stopWorkspaceReplay()
      workspacePending.current = pending
      for (const terminal of Object.values(terminalsRef.current)) {
        terminal?.setWorkspaceTransitionLocked(pending)
        if (pending) terminal?.setArmed(false)
      }
    },
    [stopWorkspaceReplay]
  )
  const publishWorkspace = useCallback(
    (grid: PreparedChartGrid) => {
      visibleGrid.current = grid
      terminalsRef.current = Object.fromEntries(grid.terminals)
      updateReplayMembers()
      setPaneSymbols(Object.fromEntries(grid.symbols))
      setPaneObjects(Object.fromEntries(grid.objects))
      const focused = grid.terminals.get(grid.payload.activePaneId) ?? null
      activeRef.current = focused
      setFocusedPane(grid.payload.activePaneId)
      setSync(grid.payload.sync)
      setArmed(false)
      setTool(null)
      const draw = focused?.drawStats() ?? NO_DRAW
      setStats(draw)
      setMagnet(draw.magnet)
      setStay(draw.stay)
    },
    [updateReplayMembers]
  )
  const workspace = useWorkspaceGridTransition(account, publishWorkspace, lockWorkspace)

  const bindAlertRuntime = (
    terminals: Iterable<[string, TradingTerminal | null]>,
    workspaceId: string | null,
    mode: 'restore' | 'seed'
  ) => {
    for (const [paneId, terminal] of terminals) {
      terminal?.setAlertRuntimeScope(
        account && workspaceId ? alertRuntimeKey(account, workspaceId, paneId) : null,
        mode
      )
    }
  }

  const captureWorkspace = () => {
    if (workspacePending.current) throw new Error('Wait for the workspace to finish loading')
    if (replaySnapshotRef.current.phase !== 'idle')
      throw new Error('Stop replay before saving the workspace')
    if (visibleGrid.current) return visibleGrid.current.capture(focusedPane, sync)
    const panes = layout.cells.map((_, index) => {
      const id = `p${index}`,
        terminal = terminalsRef.current[id]
      if (!terminal) throw new Error('Every chart must be ready before saving')
      return terminal.captureWorkspacePane(id)
    })
    return capturePresetWorkspace(
      layout,
      panes,
      panes.some((pane) => pane.id === focusedPane) ? focusedPane : panes[0].id,
      sync
    )
  }
  const autosave = useWorkspaceAutosave({
    identity: activeWorkspaceId ? `${account}:${activeWorkspaceId}` : null,
    enabled: workspaceCatalog.catalog?.autosave === true,
    paused: workspace.pending || replaySnapshot.phase !== 'idle',
    isPaused: () => workspacePending.current || replaySnapshotRef.current.phase !== 'idle',
    capture: captureWorkspace,
    save: async (payload) => {
      if (!activeWorkspaceId) throw new Error('Save this workspace with a name first')
      await workspaceCatalog.run((repository) =>
        repository.saveWorkspace(activeWorkspaceId, payload)
      )
    },
  })
  useEffect(() => {
    if (activeWorkspaceId && saveStamp > 0) {
      autosave.markSaved(savedWorkspaceSnapshot.current)
      savedWorkspaceSnapshot.current = undefined
    }
  }, [activeWorkspaceId, saveStamp, autosave.markSaved])
  useEffect(() => {
    if (workspace.pending) setArmed(false)
  }, [workspace.pending])
  const openWorkspace = async (document: WorkspaceDocument) => {
    const revision = workspaceCatalog.catalog?.revision
    await workspace.open(
      document,
      (signal) =>
        workspaceCatalog.run((repository) =>
          repository.openWorkspace(document.id, { signal, expectedRevision: revision })
        ),
      (grid) => bindAlertRuntime(grid.terminals, document.id, 'restore')
    )
    setActiveWorkspaceId(document.id)
    setWorkspaceMessage('Saved')
    setSaveStamp((value) => value + 1)
  }
  const saveWorkspaceAs = async (name: string) => {
    const payload = captureWorkspace()
    const document = await workspaceCatalog.run(async (repository) => {
      const saved = await repository.createWorkspace(name, payload)
      await repository.openWorkspace(saved.id)
      return saved
    })
    savedWorkspaceSnapshot.current = payload
    bindAlertRuntime(Object.entries(terminalsRef.current), document.id, 'seed')
    setActiveWorkspaceId(document.id)
    setWorkspaceMessage('Saved')
    setSaveStamp((value) => value + 1)
    return document
  }
  const createWorkspace = async (name: string) => {
    const payload = capturePresetWorkspace(
      LAYOUTS[0],
      [
        {
          id: 'p0',
          symbol: 'BHEL',
          exchange: 'NSE',
          interval: '5m',
          chartType: 'candlestick',
          chart: { version: 1 },
          settings: {},
          volume: true,
          magnet: 'off',
          stay: false,
          comparisons: [],
          comparisonMode: 'price',
        },
      ],
      'p0',
      SYNC_DEFAULT
    )
    return prepareNewWorkspace(payload, (repository) => repository.createWorkspace(name, payload))
  }
  const prepareNewWorkspace = async (
    payload: WorkspacePayload,
    create: Parameters<typeof workspaceCatalog.run<WorkspaceDocument>>[0]
  ) => {
    let saved: WorkspaceDocument | undefined
    await workspace.open(
      payload,
      (signal) =>
        workspaceCatalog.run(async (repository) => {
          signal.throwIfAborted()
          saved = await create(repository)
          signal.throwIfAborted()
          await repository.openWorkspace(saved.id, { signal })
        }),
      (grid) => {
        if (saved) bindAlertRuntime(grid.terminals, saved.id, 'seed')
      }
    )
    if (!saved) throw new Error('Workspace was not saved')
    setActiveWorkspaceId(saved.id)
    setWorkspaceMessage('Saved')
    setSaveStamp((value) => value + 1)
    return saved
  }
  const changeLayout = (id: string) => {
    if (workspacePending.current) return
    const next = LAYOUTS.find((item) => item.id === id)
    if (!next) return
    stopWorkspaceReplay()
    if (!visibleGrid.current && !activeWorkspaceId) {
      if (!next.cells.some((_, index) => `p${index}` === focusedPane)) {
        focusPane(terminalsRef.current.p0 ?? null, 'p0')
      }
      setLayoutId(id)
      setWorkspaceMessage('Unsaved')
      autosave.changed()
      return
    }
    try {
      const current = captureWorkspace()
      const panes = next.cells.map((_, index) => ({
        ...(current.panes[index] ?? current.panes[0]),
        id: `p${index}`,
      }))
      const focusedIndex = current.panes.findIndex((pane) => pane.id === focusedPane)
      const nextFocus = focusedIndex >= 0 && focusedIndex < panes.length ? `p${focusedIndex}` : 'p0'
      const payload = capturePresetWorkspace(next, panes, nextFocus, sync)
      void workspace
        .open(
          payload,
          async () => {},
          (grid) => bindAlertRuntime(grid.terminals, activeWorkspaceId, 'seed')
        )
        .then(() => {
          setLayoutId(id)
          setWorkspaceMessage('Unsaved')
          autosave.changed()
        })
        .catch(() => {})
    } catch (error) {
      setWorkspaceMessage(error instanceof Error ? error.message : String(error))
    }
  }
  useEffect(() => {
    if (
      restoreAttempted.current ||
      workspaceCatalog.loading ||
      !workspaceCatalog.catalog ||
      !apiKey ||
      !wsUrl
    )
      return
    restoreAttempted.current = true
    const document = workspaceCatalog.catalog.workspaces.find(
      (item) => item.id === workspaceCatalog.catalog?.activeWorkspaceId
    )
    if (document) void openWorkspace(document).catch(() => {})
  })
  const workspaceMenu = (
    <WorkspaceMenu
      {...workspaceCatalog}
      activeId={activeWorkspaceId}
      transitionPending={workspace.pending}
      cancelOpening={workspace.cancel}
      status={autosave.status}
      error={autosave.error || workspaceCatalog.error}
      saveAs={saveWorkspaceAs}
      create={createWorkspace}
      openWorkspace={openWorkspace}
      importWorkspace={(document) =>
        prepareNewWorkspace(document, async (repository) => {
          const saved = await repository.importDocument(document)
          if (saved.kind !== 'workspace') throw new Error('Expected a chart workspace')
          return saved
        })
      }
      save={async () => {
        if (!activeWorkspaceId) throw new Error('Save this workspace with a name first')
        if (replaySnapshotRef.current.phase !== 'idle')
          throw new Error('Stop replay before saving the workspace')
        autosave.changed()
        await autosave.flush()
      }}
      onRemoved={(id) => {
        if (activeWorkspaceId === id) {
          bindAlertRuntime(Object.entries(terminalsRef.current), null, 'seed')
          setActiveWorkspaceId(null)
          setWorkspaceMessage('Unsaved')
        }
        if (account) {
          try {
            removeWorkspaceAlertRuntime(localStorage, account, id)
          } catch {
            setWorkspaceMessage('Workspace removed, but its alert history could not be cleared')
          }
        }
      }}
    />
  )
  const paneCount = workspace.current?.payload.panes.length ?? layout.cells.length
  const activeLayoutId = workspace.current?.payload.layout.preset ?? layoutId
  const activeLayoutLabel = LAYOUTS.find((item) => item.id === activeLayoutId)?.label ?? 'Custom'

  /** Workspace controls share one row with the selected chart's controls. */
  const layoutPicker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          title={`Layout: ${activeLayoutLabel}`}
          aria-label={`Chart layout: ${activeLayoutLabel}`}
        >
          <LayoutGrid className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="grid grid-cols-4 gap-1 p-1">
          {LAYOUTS.map((l) => (
            <DropdownMenuItem
              key={l.id}
              onSelect={() => changeLayout(l.id)}
              title={l.label}
              className={cn(
                'flex aspect-square flex-col items-center justify-center gap-1 rounded border',
                l.id === layoutId
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'text-muted-foreground'
              )}
            >
              <LayoutIcon preset={l} />
              <span className="text-[9px] font-medium">{l.cells.length}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  /**
   * Chart sync, beside the layout picker because the two describe the same
   * thing: how the panes relate to each other. Page-level, so only pane zero
   * carries it.
   *
   * The trigger lights up only while something is actually linked, and it is
   * disabled outright on a single-pane layout. A group of one has nobody to
   * sync with, so an inviting control there would promise something it cannot
   * do; disabled with its state still readable is the honest version.
   */
  const syncOn = sync.crosshair || sync.viewport || sync.symbol || sync.interval
  const syncPicker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          disabled={paneCount < 2}
          className={cn('h-8 w-8 shrink-0', syncOn && paneCount > 1 && 'text-primary')}
          title={
            paneCount < 2
              ? 'Chart sync needs more than one pane'
              : syncOn
                ? 'Chart sync is on'
                : 'Chart sync is off'
          }
          aria-label="Chart sync"
        >
          <LinkIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Sync across panes
        </div>
        {(
          [
            ['crosshair', 'Crosshair', 'Mirror the hovered bar'],
            ['viewport', 'Time range', 'Mirror pan and zoom'],
            ['symbol', 'Symbol', 'Load the same instrument everywhere'],
            ['interval', 'Interval', 'Use the same interval where supported'],
          ] as const
        ).map(([key, label, hint]) => (
          // A label, not a button, and the row carries no click handler of its
          // own. A <button> wrapping a checkbox is invalid HTML and behaves
          // exactly as badly as that suggests: the row handler and the input's
          // own change both fire, the switch toggles twice, and it appears to
          // do nothing at all. The label forwards a click on the text to the
          // input, so every part of the row toggles it exactly once.
          //
          // Independent switches keep the menu open while they are set.
          <label
            key={key}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent"
          >
            <TickBox
              checked={sync[key]}
              onChange={(next) => {
                if (key === 'symbol' || key === 'interval') stopWorkspaceReplay()
                setSync((p) => ({ ...p, [key]: next }))
                autosave.changed()
              }}
              label={label}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-5">{label}</span>
              <span className="block text-[11px] leading-4 text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  /**
   * One-Click, beside the layout and sync pickers because, like them, it is a
   * property of the workspace and not of one pane. The switch is the control
   * and the badge is its label, so the badge reads the state in the scalping
   * terminal's words and clicking either toggles it once. A label, not a
   * button, for the reason the sync rows give: a button wrapping a switch
   * fires twice.
   */
  const armedControl = (
    <label className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 pl-1">
      <Switch checked={armed} onCheckedChange={setArmed} aria-label="One-Click" />
      {/* The word goes below lg, as Indicators and Replay drop their labels:
          with it the single-pane toolbar at 1024px pushed the LED and the
          camera into hidden horizontal scroll. The switch keeps its name. */}
      <Badge variant={armed ? 'destructive' : 'secondary'}>
        <span className="hidden lg:inline">One-Click&nbsp;</span>
        {armed ? 'ARMED' : 'off'}
      </Badge>
    </label>
  )

  const chartIds =
    workspace.current?.geometry.panes.map((pane) => pane.id) ??
    layout.cells.map((_, index) => `p${index}`)
  const chartSelector = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          data-workspace-control
          aria-label={`Selected chart: ${chartIds.indexOf(focusedPane) + 1}`}
        >
          Chart {chartIds.indexOf(focusedPane) + 1}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-workspace-control>
        {chartIds.map((id, index) => (
          <DropdownMenuItem
            key={id}
            onSelect={() => focusPane(terminalsRef.current[id] ?? null, id)}
            className={cn(id === focusedPane && 'bg-primary/10 text-primary')}
          >
            Chart {index + 1}
            {paneSymbols[id] ? `: ${paneSymbols[id]}` : ''}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
  const scalperButton = (
    <Button
      variant={scalperOpen ? 'default' : 'outline'}
      size="sm"
      className={cn(scalperOpen && 'bg-violet-600 hover:bg-violet-700 text-white', 'h-8 shrink-0')}
      onClick={() => setScalperOpen((v) => !v)}
    >
      <Zap className="mr-2 h-4 w-4" />
      Scalper
    </Button>
  )

  const workspaceControls = (
    <>
      {scalperButton}
      {layoutPicker}
      {syncPicker}
      {workspaceMenu}
      <IndicatorTemplates key={account} {...workspaceCatalog} target={panelTarget} />
      {armedControl}
    </>
  )

  return (
    <>
      {scalperOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={scalperElRef}
          onPointerDown={() => setScalperZIndex((n) => n + 1)}
          style={{
            position: 'fixed',
            zIndex: scalperZIndex,
            bottom: '24px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: '460px',
            maxWidth: 'calc(100vw - 2rem)',
            touchAction: 'none',
          }}
        >
          <div className="overflow-hidden rounded-xl border border-violet-500/30 bg-background/95 shadow-2xl shadow-violet-500/10 backdrop-blur-sm">
            <div
              className="flex cursor-grab select-none items-center justify-between border-b border-violet-500/20 bg-violet-600/10 px-4 py-2 active:cursor-grabbing"
              onPointerDown={(e) => {
                if (e.button !== 0) return
                const el = scalperElRef.current
                if (!el) return
                e.currentTarget.setPointerCapture(e.pointerId)
                const rect = el.getBoundingClientRect()
                el.style.transform = 'none'
                el.style.left = rect.left + 'px'
                el.style.top = rect.top + 'px'
                el.style.bottom = 'auto'
                scalperDragRef.current = {
                  startX: e.clientX,
                  startY: e.clientY,
                  origX: rect.left,
                  origY: rect.top,
                }
              }}
              onPointerMove={(e) => {
                const drag = scalperDragRef.current
                const el = scalperElRef.current
                if (!drag || !el) return
                const dx = e.clientX - drag.startX
                const dy = e.clientY - drag.startY
                const newX = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, drag.origX + dx))
                const newY = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, drag.origY + dy))
                el.style.left = newX + 'px'
                el.style.top = newY + 'px'
              }}
              onPointerUp={() => {
                scalperDragRef.current = null
              }}
            >
              <div className="grid w-full grid-cols-3 items-center">
                {/* Left */}
                <div className="flex justify-start">
                  <select
                    value={scalperIndex}
                    onChange={(e) => setScalperIndex(e.target.value as QoUnderlying)}
                    className="h-6 bg-background px-2 text-xs font-medium text-foreground outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Scalper index"
                  >
                    {qoOptions.map((instrument) => (
                      <option key={instrument.value} value={instrument.value}>
                        {instrument.value}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Center */}
                <div className="truncate text-center text-xs text-muted-foreground">
                  {scalperIndex} · {qoExpiry ? convertExpiryForQO(qoExpiry) : '—'}
                </div>

                {/* Right */}
                <div className="flex justify-end">
                  {scalperUnderlyingLtp != null && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      Spot ₹{scalperUnderlyingLtp.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setScalperOpen(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="space-y-2.5 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex shrink-0 overflow-hidden rounded-md border border-border">
                  <button
                    className={cn(
                      'px-3 py-1.5 text-xs font-bold transition-colors',
                      scalperMode === 0 ? 'bg-green-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    )}
                    onClick={() => setScalperMode(0)}
                  >
                    CE
                  </button>
                  <button
                    className={cn(
                      'px-3 py-1.5 text-xs font-bold transition-colors',
                      scalperMode === 1 ? 'bg-red-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    )}
                    onClick={() => setScalperMode(1)}
                  >
                    PE
                  </button>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0"
                  disabled={qoAtmIndex + scalperOffset <= 0}
                  onClick={() => setScalperOffset((o) => o - 1)}
                  title="Lower strike"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>

                <div className="flex flex-1 flex-col items-center">
                  {scalperStrike != null ? (
                    <>
                      <span className="text-base font-bold font-mono leading-tight">{scalperStrike}</span>
                      <div className="mt-0.5 flex items-center gap-1">
                        {scalperOffset === 0 && (
                          <span className="h-4 border border-border px-1 text-[9px] leading-4">ATM</span>
                        )}
                        {scalperOffset !== 0 && (
                          <span
                            className={cn(
                              'h-4 border px-1 text-[9px] leading-4',
                              scalperMode === 0 && scalperOffset < 0
                                ? 'border-amber-500/40 text-amber-500'
                                : 'border-border text-muted-foreground'
                            )}
                          >
                            {scalperMode === 0 ? (scalperOffset < 0 ? 'OTM' : 'ITM') : (scalperOffset < 0 ? 'ITM' : 'OTM')} {scalperOffset > 0 ? `+${scalperOffset}` : scalperOffset}
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Loading…</span>
                  )}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0"
                  disabled={qoAtmIndex + scalperOffset >= qoStrikeList.length - 1}
                  onClick={() => setScalperOffset((o) => o + 1)}
                  title="Higher strike"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>

                <div className="min-w-[68px] shrink-0 text-right">
                  <span className={cn('text-sm font-bold font-mono', scalperMode === 0 ? 'text-green-600' : 'text-red-500')}>
                    {scalperLtp != null ? `₹${scalperLtp.toFixed(2)}` : '—'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="flex-1 bg-green-600 text-sm font-bold text-white hover:bg-green-700 active:bg-green-800 disabled:opacity-50"
                  disabled={!scalperSymbol || scalperIsPlacing}
                  onClick={() => handleScalperOrder('BUY')}
                >
                  {scalperIsPlacing ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Buy {scalperMode === 0 ? 'CE' : 'PE'}</>}
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 border-2 border-red-500 text-sm font-bold text-red-500 hover:bg-red-500/10 active:bg-red-500/20 disabled:opacity-50"
                  disabled={!scalperSymbol || scalperIsPlacing}
                  onClick={() => handleScalperOrder('SELL')}
                >
                  {scalperIsPlacing ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Sell {scalperMode === 0 ? 'CE' : 'PE'}</>}
                </Button>

                <div className="flex shrink-0 flex-col items-center gap-0.5">
                  <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Lots</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={scalperLots}
                    onChange={(e) => {
                      const v = parseInt(e.target.value)
                      if (!isNaN(v) && v >= 1) setScalperLots(v)
                    }}
                    className="h-8 w-[72px] rounded-md border border-input bg-background px-2 text-left text-sm font-bold focus:outline-none focus:ring-1 focus:ring-ring [appearance:auto]"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-0.5">
                <span className="shrink-0 text-[10px] text-muted-foreground">SL</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={scalperDefaultSL}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!isNaN(v) && v >= 0) setScalperDefaultSL(v)
                  }}
                  className="h-6 w-14 px-1.5 text-center text-xs"
                />
                <span className="ml-2 text-[10px] text-muted-foreground">Trail</span>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={scalperDefaultTrail}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!isNaN(v) && v >= 0) setScalperDefaultTrail(v)
                  }}
                  className="h-6 w-14 px-1.5 text-center text-xs"
                />
                <span className="ml-auto whitespace-nowrap text-[10px] font-mono text-muted-foreground">
                  qty: {scalperLots} × {scalperLotSize} = {scalperLots * scalperLotSize} &nbsp;|&nbsp;
                  {scalperLtp != null
                    ? `₹${(scalperLots * scalperLotSize * scalperLtp).toFixed(2)}`
                    : '—'}
                </span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Full-bleed page: the nav must match the chart width, not
          Layout's centred container. See NavbarProps.fluid. */}
      <Navbar fluid />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Rail + grid */}
        <div aria-live="polite">
          {autosave.error && (
            <p role="alert" className="px-3 py-1 text-sm text-destructive">
              Workspace not saved: {autosave.error}
            </p>
          )}
          {workspaceMessage !== 'Saved' && workspaceMessage !== 'Unsaved' && (
            <p role="alert" className="px-3 py-1 text-sm text-destructive">
              {workspaceMessage}
            </p>
          )}
          {workspace.pending && (
            <output className="flex items-center gap-3 px-3 py-1 text-sm">
              Loading workspace...
              <Button variant="ghost" size="sm" onClick={workspace.cancel}>
                Cancel
              </Button>
            </output>
          )}
          {workspace.error && (
            <p role="alert" className="px-3 py-1 text-sm text-destructive">
              {workspace.error}
            </p>
          )}
        </div>
        <div ref={setToolbarHost} className="min-w-0 shrink-0" data-workspace-toolbar />
        <main className="flex min-h-0 flex-1" inert={workspace.pending ? true : undefined}>
          {showRail && apiKey && wsUrl && (
            <DrawingRail
              stats={railStats}
              onPick={(id) => setTool(id)}
              onUndo={() => act((t) => t.undoDraw())}
              onRedo={() => act((t) => t.redoDraw())}
              onRemove={(all) => act((t) => t.removeDrawings(all))}
              onMagnet={(v) => {
                setMagnet(v)
                if (visibleGrid.current)
                  for (const terminal of visibleGrid.current.terminals.values())
                    terminal.setMagnet(v)
              }}
              onStay={(v) => {
                setStay(v)
                if (visibleGrid.current)
                  for (const terminal of visibleGrid.current.terminals.values())
                    terminal.setDrawStay(v)
              }}
              onShortcut={onDrawKey}
            />
          )}
          <div className="relative min-h-0 min-w-0 flex-1">
            {noApiKey ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm text-muted-foreground">No API key found for charting.</p>
                <a href="/apikey" className="text-sm font-medium text-primary underline">
                  Generate an API key
                </a>
              </div>
            ) : apiKey && wsUrl && linkGroup ? (
              <div className="relative h-full">
                {!workspace.current && (
                  <div
                    key="unnamed"
                    className="grid h-full min-h-0 gap-2 p-2"
                    style={{
                      gridTemplateColumns: layout.cols,
                      gridTemplateRows: layout.rows,
                      gridTemplateAreas: layout.areas,
                    }}
                  >
                    {layout.cells.map((cell, i) => (
                      <ChartPane
                        key={`p${i}`}
                        paneId={`p${i}`}
                        paneLabel={`Chart ${i + 1}`}
                        toolbarHost={toolbarHost}
                        focused={focusedPane === `p${i}`}
                        chartSelector={chartSelector}
                        apiKey={apiKey}
                        wsUrl={wsUrl}
                        style={{ gridArea: cell }}
                        sharedTool={tool}
                        sharedMagnet={magnet}
                        sharedStay={stay}
                        onWorkspaceChange={autosave.changed}
                        onReplayStart={startWorkspaceReplay}
                        workspaceReplay={replaySnapshot}
                        onBeforeSourceChange={stopWorkspaceReplay}
                        onFocusPane={focusPane}
                        onSymbolChange={(id, key) => {
                          if (!visibleGrid.current) noteSymbol(id, key)
                        }}
                        onTerminalChange={noteTerminal}
                        onObjectsChange={(id, objects) => {
                          if (!visibleGrid.current) noteObjects(id, objects)
                        }}
                        onDrawStats={(value) => {
                          if (!visibleGrid.current) setStats(value)
                        }}
                        onToggleRail={() => setShowRail((v) => !v)}
                        railVisible={showRail}
                        linkGroup={linkGroup}
                        armed={armed}
                        transitionLocked={workspace.pending}
                        layoutPicker={workspaceControls}
                      />
                    ))}
                  </div>
                )}
                {workspace.grids.map((owner) => (
                  <WorkspaceGrid
                    key={owner.key}
                    owner={owner}
                    active={workspace.current === owner}
                    toolbarHost={toolbarHost}
                    focusedPaneId={focusedPane}
                    chartSelector={chartSelector}
                    apiKey={apiKey}
                    wsUrl={wsUrl}
                    sharedTool={tool}
                    transitionLocked={workspace.pending}
                    armed={armed}
                    railVisible={showRail}
                    onToggleRail={() => setShowRail((value) => !value)}
                    onWorkspaceChange={autosave.changed}
                    onReplayStart={startWorkspaceReplay}
                    workspaceReplay={replaySnapshot}
                    onBeforeSourceChange={stopWorkspaceReplay}
                    onFocusPane={focusPane}
                    onSymbolChange={noteSymbol}
                    onObjectsChange={noteObjects}
                    onDrawStats={setStats}
                    onTerminalChange={(id, terminal) => {
                      if (visibleGrid.current !== owner) return
                      if (terminal) terminalsRef.current[id] = terminal
                      else delete terminalsRef.current[id]
                      updateReplayMembers()
                    }}
                    layoutPicker={workspaceControls}
                  />
                ))}
                <WorkspaceReplayBar
                  snapshot={replaySnapshot}
                  error={replayError}
                  ownerLabel={
                    replaySnapshot.ownerId
                      ? (paneSymbols[replaySnapshot.ownerId] ?? replaySnapshot.ownerId)
                      : undefined
                  }
                  onScopeChange={(scope) => replayCoordinator.current?.setScope(scope)}
                  onPlay={(speed) => replayCoordinator.current?.play(speed)}
                  onPause={() => replayCoordinator.current?.pause()}
                  onStep={() => replayCoordinator.current?.step()}
                  onStepBack={() => replayCoordinator.current?.stepBack()}
                  onSeek={(index) => replayCoordinator.current?.seek(index)}
                  onStop={requestReplayExit}
                  confirmExit={confirmReplayExit}
                  onCancelExit={() => setConfirmReplayExit(false)}
                  onConfirmExit={stopWorkspaceReplay}
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading charting terminal…
              </div>
            )}
          </div>

          {/* Side panels, between the grid and the rail that toggles them.
              Both are page-level: they act on the focused pane rather than
              belonging to one, so repeating them per pane would be wrong. */}
          {apiKey && wsUrl && panel === 'watchlist' && (
            <WatchlistPanel
              apiKey={apiKey}
              onPick={sendToFocusedPane}
              search={searchFromFocusedPane}
              activeSymbol={paneSymbols[focusedPane] ?? null}
            />
          )}
          {apiKey && wsUrl && panel === 'options' && (
            <OptionChainPanel
              apiKey={apiKey}
              onPick={sendToFocusedPane}
              activeSymbol={paneSymbols[focusedPane] ?? null}
            />
          )}
          {apiKey && wsUrl && panel === 'agent' && (
            <Suspense fallback={null}>
              <AgentPanel
                getChartContext={readChartContext}
                onChartCommand={applyChartCommands}
                onCaptureChart={captureChart}
              />
            </Suspense>
          )}
          {apiKey && wsUrl && panel === 'objects' && (
            <ObjectsPanel model={paneObjects[objectsPaneId] ?? null} paneLabel={objectsPaneLabel} />
          )}

          {apiKey && wsUrl && <RightRail active={panel} onSelect={setPanel} />}
        </main>

        {/* The bottom dock: orders, positions and trades across every symbol.
            Under the rails and the side panel, full width, because the books
            are the workspace's and not one pane's. */}
        {apiKey && wsUrl && (
          <TradingDock
            tab={dock}
            onTabChange={setDock}
            apiKey={apiKey}
            onPick={sendToFocusedPane}
            activeSymbol={paneSymbols[focusedPane] ?? null}
            tradingLocked={tradingLocked}
          />
        )}
      </div>
    </>
  )
}