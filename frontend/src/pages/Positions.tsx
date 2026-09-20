import {
  AlertTriangle,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Pause,
  Plus,
  Radio,
  RefreshCw,
  Settings2,
  X,
  Shield,
  Check,
  XIcon,
  Zap,
} from 'lucide-react'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { showToast } from '@/utils/toast'
import { tradingApi } from '@/api/trading'
import { oiProfileApi } from '@/api/oi-profile'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useLivePrice } from '@/hooks/useLivePrice'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import { cn, sanitizeCSV } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import type { Position } from '@/types/trading'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { PlaceOrderDialog } from '@/components/trading/PlaceOrderDialog'
import { useLiveQuote } from '@/hooks/useLiveQuote'

// ─────────────────────────── Constants ────────────────────────────────────────

const POLLING_INTERVAL_LIVE    = 25000
const POLLING_INTERVAL_DEFAULT = 10000
const STALE_DATA_THRESHOLD     = 120000
const STALE_WARNING_DURATION   = 3000
//const MULTIQUOTES_REFRESH_INTERVAL = 2000  // match QO panel tick speed
//const PRICE_STALE_THRESHOLD    = 2000
//const PROTECTION_POLL_INTERVAL = 2000   // 2 s — faster engine status sync

const POLLING_WHEN_HIDDEN = false
const DEFAULT_PORTFOLIO_SL_PERCENT = 10
const MIN_PORTFOLIO_SL_PERCENT     = 2
const MAX_PORTFOLIO_SL_PERCENT     = 20

const QO_UNDERLYINGS = ['NIFTY', 'SENSEX'] as const

const INDEX_LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 140,
  NIFTYNXT50: 25,
  SENSEX: 20,
  BANKEX: 30,
  SENSEX50: 70,
}

// ─────────────────────────── Types ────────────────────────────────────────────

type SortColumn    = 0 | 3 | 4 | 6 | 7 | null
type SortDirection = 'asc' | 'desc'

interface FilterState {
  direction: string[]
  exchange:  string[]
}

interface PositionProtection {
  sl_price?:             number
  target_price?:         number
  trailing_points?:      number
  best_price?:           number
  current_sl?:           number
  status?:               'ACTIVE' | 'TRIGGERED' | 'CLOSED'
  break_even_activated?: boolean
}

type PositionWithPnlPercent = Position & {
  pnlPercent: number
  pnlIsLive:  boolean   // true = computed from live LTP; false = broker fallback
  sl?:     number
  target?: number
  trail?:  number
}

// ─────────────────────────── Helpers ──────────────────────────────────────────

function roundToTick(price: number, tickSize = 0.05) {
  return Math.round(price / tickSize) * tickSize
}

/**
 * Returns true when `ltp` looks like a contaminated value — either the
 * underlying spot price or the strike price — rather than a real option/
 * future LTP.  This can happen with some broker APIs before the WebSocket
 * delivers the first real tick.
 *
 * Logic:
 *  • For NSE/BSE equities and futures, any positive, finite price is valid
 *    (their LTPs can legitimately be large integers).
 *  • For NFO/BFO options (CE/PE), a real LTP is almost always < ₹10,000.
 *    Values > 10,000 are almost certainly the spot index or the strike.
 *    We additionally catch the specific "round-number strike" pattern.
 *  • As a cross-check, if avgPrice is known and the ratio ltp/avgPrice > 20
 *    (or < 1/20), the price is clearly wrong — spot index leaking into an
 *    option that is worth a few rupees.
 */
function isLtpSuspect(
  ltp: number,
  exchange: string,
  symbol: string,
  avgPrice: number,
): boolean {
  if (!isFinite(ltp) || ltp <= 0) return true

  const isOption =
    (exchange === 'NFO' || exchange === 'BFO') &&
    (symbol?.endsWith('CE') || symbol?.endsWith('PE'))

  if (!isOption) return false   // equities & futures: trust the value

  // 1. Absolute ceiling: real option LTPs do not exceed 10 000
  if (ltp > 10_000) return true

  // 2. Round-number strike pattern (e.g. 24800, 25000, 25100)
  if (Number.isInteger(ltp) && ltp > 3_000 && (ltp % 50 === 0 || ltp % 100 === 0)) return true

  // 3. Ratio sanity check vs average_price
  //    If avg is known and ltp is >20x or <1/20 of avg, it is contaminated.
  if (avgPrice > 0) {
    const ratio = ltp / avgPrice
    if (ratio > 20 || ratio < 0.05) return true
  }

  return false
}


function getPositionPnlPercent(position: Position): number {
  // Use broker-provided pnlpercent if available
  if (position.pnlpercent !== undefined && position.pnlpercent !== null) {
    return Number(position.pnlpercent)
  }
  
  // Fallback calculation only if broker doesn't provide it
  const avgPrice = Number(position.average_price) || 0
  const qty = Number(position.quantity) || 0
  const pnl = Number(position.pnl) || 0
  
  if (qty === 0 || avgPrice === 0) return 0
  const investment = Math.abs(avgPrice * qty)
  return investment > 0 ? (pnl / investment) * 100 : 0
}


function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2,
  }).format(value)
}

function parseSymbol(symbol: string, exchange: string) {
  if (exchange === 'NSE' || exchange === 'BSE') {
    return { underlying: symbol, expiry: null, strike: null, optionType: null }
  }
  const futMatch = symbol.match(/^(.+?)(\d{1,2}[A-Z]{3}\d{2})FUT$/i)
  if (futMatch) {
    return { underlying: futMatch[1], expiry: futMatch[2], strike: null, optionType: 'FUT' }
  }
  const optMatch = symbol.match(/^(.+?)(\d{1,2}[A-Z]{3}\d{2})(\d+\.?\d*)(CE|PE)$/i)
  if (optMatch) {
    return { underlying: optMatch[1], expiry: optMatch[2], strike: optMatch[3], optionType: optMatch[4] }
  }
  return { underlying: symbol, expiry: null, strike: null, optionType: null }
}

function getLotSize(symbol: string, exchange: string, fallback = 1): number {
  const parsed = parseSymbol(symbol, exchange)
  if (INDEX_LOT_SIZES[parsed.underlying]) return INDEX_LOT_SIZES[parsed.underlying]
  if (exchange === 'NSE' || exchange === 'BSE') return 1
  return fallback
}


const isPositionClosed = (position: PositionWithPnlPercent) => (position.quantity ?? 0) === 0

const EXCHANGE_COLORS: Record<string, string> = {
  NSE: 'bg-cyan-500/20 text-cyan-600 border-cyan-500/30',
  BSE: 'bg-slate-500/20 text-slate-600 border-slate-500/30',
  NFO: 'bg-purple-500/20 text-purple-600 border-purple-500/30',
  BFO: 'bg-amber-500/20 text-amber-600 border-amber-500/30',
  MCX: 'bg-blue-500/20 text-blue-600 border-blue-500/30',
  CDS: 'bg-teal-500/20 text-teal-600 border-teal-500/30',
}

const PRODUCT_COLORS: Record<string, string> = {
  CNC:  'bg-purple-500/20 text-purple-600 border-purple-500/30',
  MIS:  'bg-cyan-500/20 text-cyan-600 border-cyan-500/30',
  NRML: 'bg-slate-500/20 text-slate-600 border-slate-500/30',
}

// ─────────────────────────── Protection API helpers ──────────────────────────

async function fetchProtectionsFromServer(): Promise<Record<string, PositionProtection>> {
  try {
    const res  = await fetch('/api/protection/load', { credentials: 'include' })
    if (!res.ok) return {}
    const data = await res.json()
    return data.status === 'success' ? (data.protections ?? {}) : {}
  } catch {
    return {}
  }
}

async function saveProtectionToServer(key: string, protection: PositionProtection): Promise<void> {
  try {
    await fetch('/api/protection/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key, protection }),
    })
  } catch (err) {
    console.error('Protection save failed', err)
  }
}

async function deleteProtectionFromServer(key: string): Promise<void> {
  try {
    await fetch('/api/protection/delete', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key }),
    })
  } catch (err) {
    console.error('Delete protection failed', err)
  }
}

// ─────────────────────────── Z-Index manager ─────────────────────────────────
// Shared between Scalper panel and PlaceOrderDialog so whichever is clicked
// last comes to the front — no window is permanently on top.
let _zCounter = 1000
function _nextZ() { return ++_zCounter }

// ─────────────────────────── Component ────────────────────────────────────────

export default function Positions() {

  // ── Protection state ──────────────────────────────────────────────────────
  const [protectionState, setProtectionState] = useState<Record<string, PositionProtection>>({})
  const protectionStateRef = useRef<Record<string, PositionProtection>>({})
  const toastedTriggerRef = useRef<Set<string>>(new Set())
  // Keys written locally (via event or scalper) that haven't been confirmed by
  // the server yet. The poll will NOT overwrite these until they expire.
  const pendingProtectionsRef = useRef<Map<string, { protection: PositionProtection; expiresAt: number }>>(new Map())

  // Add after existing state declarations
  const [brokerageSettings, setBrokerageSettings] = useState({
    flat_brokerage: 20,
    tax_percent: 0.0025
  })
  const [brokerageLoading, setBrokerageLoading] = useState(false)

  // Keep ref in sync so tick-level checks see latest state without stale closure.
  // useLayoutEffect runs synchronously before paint, so the ref is current on
  // every tick — avoids the 1-tick stale window that useEffect had.
  useLayoutEffect(() => { protectionStateRef.current = protectionState }, [protectionState])

  // Fetch brokerage settings on mount
  useEffect(() => {
    const fetchBrokerageSettings = async () => {
      try {
        const res = await fetch('/api/protection/settings', { credentials: 'include' })
        const data = await res.json()
        if (data.status === 'success') {
          setBrokerageSettings({
            flat_brokerage: data.settings.flat_brokerage ?? 20,
            tax_percent: data.settings.tax_percent ?? 0.0025,
          })
          setPortfolioSLEnabled(Boolean(data.settings.portfolio_sl_enabled))
          setTrailEquityEnabled(Boolean(data.settings.trail_equity_enabled))
          setPortfolioSLPercent(data.settings.portfolio_sl_percent ?? DEFAULT_PORTFOLIO_SL_PERCENT)
          setScalperDefaultSL(data.settings.scalper_default_sl ?? 2)
          setScalperDefaultTrail(data.settings.scalper_default_trail ?? 2)
        }
      } catch (err) {
        console.error('Failed to fetch brokerage settings:', err)
      }
    }
    fetchBrokerageSettings()
  }, [])

  // Save brokerage settings
  const saveBrokerageSettings = async () => {
    setBrokerageLoading(true)
    try {
      const res = await fetch('/api/protection/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ...brokerageSettings,
          portfolio_sl_enabled: portfolioSLEnabled,
          trail_equity_enabled: trailEquityEnabled,
          portfolio_sl_percent: portfolioSLPercent,
          scalper_default_sl: scalperDefaultSL,
          scalper_default_trail: scalperDefaultTrail,
        })
      })
      const data = await res.json()
      if (data.status === 'success') {
        showToast.success('Brokerage settings saved', 'positions')
        // Refresh positions to recalc P&L with new settings
        fetchPositions(true)
      } else {
          showToast.error(data.message || 'Failed to save settings', 'positions')
      }
    } catch (err) {
        showToast.error('Failed to save brokerage settings', 'positions')
    } finally {
       setBrokerageLoading(false)
    }
  }

  // ── Protection persistence poll ──────────────────────────────────────────
  // Loads SL/Target/Trail values from the DB on mount and every 5s.
  // All SL/BE/Trail CALCULATIONS run in the tick useEffect below — the DB
  // is only used for persistence across page refreshes.
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      const fresh = await fetchProtectionsFromServer()
      if (!mounted) return
      // Guard: if server returns empty (network error/401), preserve current state
      if (Object.keys(fresh).length === 0) return
      setProtectionState(prev => {
        const now = Date.now()
        const merged: Record<string, PositionProtection> = { ...fresh }
        // Pending shield: protect locally-written values from poll overwrites
        // during the window after a save (e.g. user just changed SL inline)
        pendingProtectionsRef.current.forEach((entry, key) => {
          if (entry.expiresAt > now) {
            const serverEntry = fresh[key]
            if (!serverEntry) {
              merged[key] = entry.protection
            } else {
              // User-edited fields win during the shield window
              merged[key] = {
                ...serverEntry,
                ...(entry.protection.sl_price        !== undefined && { sl_price:        entry.protection.sl_price }),
                ...(entry.protection.target_price    !== undefined && { target_price:    entry.protection.target_price }),
                ...(entry.protection.trailing_points !== undefined && { trailing_points: entry.protection.trailing_points }),
                // Keep in-memory current_sl (may have been moved by tick logic)
                current_sl: prev[key]?.current_sl ?? serverEntry.current_sl ?? entry.protection.sl_price,
                // Shield window: local break_even_activated wins (may have been reset to false
                // when user set a new SL — don't let stale DB value override it)
                break_even_activated: entry.protection.break_even_activated ?? prev[key]?.break_even_activated ?? serverEntry.break_even_activated ?? false,
              }
              if (serverEntry.status === 'ACTIVE' &&
                  (serverEntry.sl_price !== undefined || serverEntry.trailing_points !== undefined || serverEntry.target_price !== undefined)) {
                pendingProtectionsRef.current.delete(key)
              }
            }
          } else {
            pendingProtectionsRef.current.delete(key)
          }
        })
        // For keys NOT in the pending shield, keep in-memory current_sl/BE state
        // so the poll doesn't overwrite trail/BE progress made since last save
        Object.keys(merged).forEach(key => {
          if (!pendingProtectionsRef.current.has(key) && prev[key]) {
            merged[key] = {
              ...merged[key],
              current_sl:           prev[key].current_sl           ?? merged[key].current_sl,
              break_even_activated: prev[key].break_even_activated ?? merged[key].break_even_activated,
            }
          }
        })
        return merged
      })
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  // ── Tick-level protection engine ──────────────────────────────────────────
  // Runs on every LTP update from useLivePrice.
  // Implements: SL check, Target check, Break-Even activation, Trailing SL.
  // All state is in-memory (protectionStateRef); DB is written on changes.

  // ── Auth & positions ──────────────────────────────────────────────────────
  const { apiKey } = useAuthStore()
  const [positions,    setPositions]    = useState<Position[]>([])
  const [isLoading,    setIsLoading]    = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [showStaleWarning, setShowStaleWarning] = useState(false)

  // The backend ProtectionEngine is the sole authority for SL/Target/Trail.
  // useLivePrice drives LTP display and live P&L only — no protection logic here.
  const { data: enhancedPositions, isLive, isPaused } = useLivePrice(positions, {
    enabled: positions.length > 0,
    useMultiQuotesFallback: true,
    staleThreshold: 5000,                  // keep WS price for 5s before treating as stale
    multiQuotesRefreshInterval: 5000,      // REST fallback polls every 5s (slower = less bad-LTP exposure)
    pauseWhenHidden: false,
  })

  useEffect(() => {
    if (!enhancedPositions.length) return
    const protections = protectionStateRef.current
    if (!Object.keys(protections).length) return

    const FIXED_BROKERAGE = brokerageSettings.flat_brokerage
    const TAX_PERCENT     = brokerageSettings.tax_percent
    const BE_RATIO        = 1.5
    const TICK_SZ         = 0.05
    const rt = (p: number) => Math.round(Math.round(p / TICK_SZ) * TICK_SZ * 100) / 100

    const updates: Record<string, PositionProtection> = {}
    const toSave: Array<{ key: string; prot: PositionProtection }> = []
    let hasUpdates = false

    enhancedPositions.forEach((position: any) => {
      const key = `${position.symbol}_${position.exchange}_${position.product}`
      const prot = protections[key]
      if (!prot || prot.status !== 'ACTIVE') return

      const qty = Number(position.quantity) ?? 0
      if (qty === 0) return

      const ltp = position.ltp
      if (ltp == null || !isFinite(ltp) || ltp <= 0) return
      if (isLtpSuspect(ltp, position.exchange, position.symbol, Number(position.average_price) || 0)) return

      const isLong  = qty > 0
      const entry   = Number(position.average_price) || 0
      let p         = { ...prot }
      let changed   = false

      // ── Break-Even ─────────────────────────────────────────────────────
      // Fires when profit ≥ BE_RATIO × initial risk (LTP must be STRICTLY
      // above/below beTrigger — ltp == entry never triggers this).
      //
      // BE price = entry + round-trip brokerage cost per unit
      //   roundTripCost = 2 × flatFee  +  2 × entry × qty × taxPercent
      //   (entry leg + exit leg both charged)
      // For a long: SL is moved to entry + roundTripCost/qty so if price
      // falls back to entry level, the trade breaks even after all charges.
      if (
        !p.break_even_activated && entry > 0 &&
        p.sl_price != null && p.current_sl != null
      ) {
        const risk    = Math.abs(entry - p.sl_price)
        const absQty  = Math.abs(qty)
        if (risk > 0 && absQty > 0) {
          // Round-trip cost = entry leg + exit leg (2× each charge)
          const roundTripCost  = 2 * FIXED_BROKERAGE + 2 * entry * absQty * TAX_PERCENT
          const costPerUnit    = roundTripCost / absQty
          // BE trigger: LTP must be STRICTLY greater (>) than beTrigger
          // ltp == entry never satisfies this — no false trigger at entry
          const beTrigger      = isLong ? entry + risk * BE_RATIO : entry - risk * BE_RATIO
          // BE price: where to move the SL so the trade breaks even
          const bePrice        = rt(isLong ? entry + costPerUnit : entry - costPerUnit)
          const alreadyAtBe   = isLong ? p.current_sl >= bePrice : p.current_sl <= bePrice
          // Strict inequality: ltp must be ABOVE beTrigger, not equal
          const triggerHit     = isLong ? ltp > beTrigger : ltp < beTrigger
          if (triggerHit && !alreadyAtBe) {
            p.current_sl           = bePrice
            p.break_even_activated = true
            changed = true
            const beKey = key + '_be'
            if (!toastedTriggerRef.current.has(beKey)) {
              toastedTriggerRef.current.add(beKey)
              showToast.success(
                `Break-even activated for ${position.symbol} — SL moved to ₹${bePrice.toFixed(2)} 🎯`,
                'positions'
              )
            }
          }
        }
      }

      // ── Trailing SL (continuous follow — NOT a step ratchet) ────────────
      // Runs independently of BE — does not require break_even_activated.
      // Only activates once LTP has moved AT LEAST trail_points away from
      // entry (so a flat/sideways position doesn't immediately trail).
      //
      // Formula: new_sl = ltp - trail_points  (for longs)
      //          new_sl = ltp + trail_points  (for shorts)
      // SL only moves in the favourable direction (never backward).
      if (
        p.trailing_points != null && p.trailing_points > 0 &&
        p.current_sl != null
      ) {
        const trail = p.trailing_points
        if (isLong) {
          // Only trail when LTP has moved above entry + trail (profit territory)
          if (ltp > entry + trail) {
            const newSl = rt(ltp - trail)
            if (newSl > p.current_sl) {
              p.current_sl = newSl
              changed = true
            }
          }
        } else {
          // For shorts: trail when LTP has moved below entry - trail
          if (ltp < entry - trail) {
            const newSl = rt(ltp + trail)
            if (newSl < p.current_sl) {
              p.current_sl = newSl
              changed = true
            }
          }
        }
      }

      // ── SL check ──────────────────────────────────────────────────────────
      let shouldClose = false
      let reason      = ''
      const activeSL  = p.current_sl != null ? p.current_sl : p.sl_price
      if (activeSL != null) {
        if (isLong  && ltp <= activeSL) { shouldClose = true; reason = 'Stop Loss Hit' }
        if (!isLong && ltp >= activeSL) { shouldClose = true; reason = 'Stop Loss Hit' }
      }

      // ── Target check ──────────────────────────────────────────────────────
      if (!shouldClose && p.target_price != null) {
        if (isLong  && ltp >= p.target_price) { shouldClose = true; reason = 'Target Hit' }
        if (!isLong && ltp <= p.target_price) { shouldClose = true; reason = 'Target Hit' }
      }

      if (shouldClose) {
        p.status = 'TRIGGERED'
        updates[key] = p
        hasUpdates = true
        toSave.push({ key, prot: p })
        const hitKey = key + '_hit'
        if (!toastedTriggerRef.current.has(hitKey)) {
          toastedTriggerRef.current.add(hitKey)
          if (reason.includes('Target')) {
            showToast.success(`${reason} for ${position.symbol} at ₹${ltp.toFixed(2)} 🎯`, 'positions')
          } else {
            showToast.error(`${reason} for ${position.symbol} at ₹${ltp.toFixed(2)} 🛑`, 'positions')
          }
        }
        // Fire close order
        handleClosePosition(position).then(() => {
          toastedTriggerRef.current.delete(hitKey)
        }).catch(() => {
          setProtectionState(prev => {
            const cur = prev[key]
            if (!cur || cur.status !== 'TRIGGERED') return prev
            return { ...prev, [key]: { ...cur, status: 'ACTIVE' } }
          })
        })
      } else if (changed) {
        updates[key] = p
        hasUpdates = true
        toSave.push({ key, prot: p })
      }
    })

    if (hasUpdates) {
      setProtectionState(prev => ({ ...prev, ...updates }))
      // Persist changed protections to DB (non-blocking)
      toSave.forEach(({ key, prot }) => {
        saveProtectionToServer(key, prot).catch(() => {})
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enhancedPositions, brokerageSettings])

  // ── Inline editing ────────────────────────────────────────────────────────
  const [editingField, setEditingField] = useState<{
    positionKey: string
    field: 'sl' | 'target' | 'trail'
    value: string
    position: PositionWithPnlPercent | null
  } | null>(null)

  // ── Place Order Dialog ────────────────────────────────────────────────────
  const [orderDialogOpen, setOrderDialogOpen]   = useState(false)
  const [orderDialogProps, setOrderDialogProps] = useState<{
    symbol: string; exchange: string; action: 'BUY' | 'SELL'
    product: 'MIS' | 'NRML' | 'CNC'; quantity: number; lotSize: number; tickSize: number
  }>({ symbol: '', exchange: '', action: 'BUY', product: 'NRML', quantity: 1, lotSize: 1, tickSize: 0.05 })

  const openOrderDialog = useCallback((
    symbol = '', exchange = '', action: 'BUY' | 'SELL' = 'BUY',
    product: 'MIS' | 'NRML' | 'CNC' = 'NRML',
    quantity = 1, lotSize = 1, tickSize = 0.05,
  ) => {
    setOrderDialogProps({ symbol, exchange, action, product, quantity, lotSize, tickSize })
    setOrderDialogOpen(true)
  }, [])

  const getPositionKey = useCallback((position: Position) => {
    return `${position.symbol}_${position.exchange}_${position.product}`
  }, [])

  const { isVisible, wasHidden, timeSinceHidden } = usePageVisibility()
  const lastFetchRef = useRef<number>(Date.now())

  // ── Filters / sorting ─────────────────────────────────────────────────────
  // Grouping and product-type filter removed. Direction + exchange filters kept.
  const [filters,      setFilters]      = useState<FilterState>({ direction: [], exchange: [] })
  const [sortColumn,   setSortColumn]   = useState<SortColumn>(null)
  const [sortDirection,setSortDirection]= useState<SortDirection>('asc')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── Quick Order Panel ─────────────────────────────────────────────────────
  const [qoUnderlying,    setQoUnderlying]    = useState<'NIFTY' | 'SENSEX'>('NIFTY')
  const qoExchange = qoUnderlying === 'NIFTY' ? 'NFO' : 'BFO'
  const [qoExpiries,      setQoExpiries]      = useState<string[]>([])
  const [qoExpiry,        setQoExpiry]        = useState('')
  const [qoStrikeList,    setQoStrikeList]    = useState<{
    strike: number; ceLtp: number | null; peLtp: number | null
    ceSym: string; peSym: string; ceLotSize: number; peLotSize: number
    ceTickSize: number; peTickSize: number
  }[]>([])
  const [qoAtmIndex,      setQoAtmIndex]      = useState(0)
  const [qoCeStrikeIndex, setQoCeStrikeIndex] = useState(0)
  const [qoPeStrikeIndex, setQoPeStrikeIndex] = useState(0)
  const qoCeUserMovedRef = useRef(false)
  const qoPeUserMovedRef = useRef(false)
  // Start enabled immediately if the tab is already visible —
  // avoids a full render cycle before QO/scalper price hooks activate.
  const [wsEnabled,       setWsEnabled]       = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'visible'
  )

  // ── Risk engine ───────────────────────────────────────────────────────────
  const [portfolioSLEnabled, setPortfolioSLEnabled] = useState(false)
  const [trailEquityEnabled, setTrailEquityEnabled] = useState(false)
  const [dailyLockout,       setDailyLockout]       = useState(false)
  const [openingBalance,     setOpeningBalance]     = useState(0)
  const [equityPeak,         setEquityPeak]         = useState(0)
  const [portfolioSLPercent, setPortfolioSLPercent] = useState(DEFAULT_PORTFOLIO_SL_PERCENT)
  const [balanceLoading,     setBalanceLoading]     = useState(true)

  // ── Scalper panel ─────────────────────────────────────────────────────────
  const [scalperOpen,        setScalperOpen]        = useState(false)
  const [scalperMode,        setScalperMode]        = useState<0 | 1>(0) // 0 = CE, 1 = PE
  const [scalperOffset,      setScalperOffset]      = useState(0)        // offset from ATM
  const [scalperLots,        setScalperLots]        = useState(1)        // session-only lot count
  // Default SL and Trail points for scalper — applied immediately on order
  const [scalperDefaultSL,   setScalperDefaultSL]   = useState(2)        // points
  const [scalperDefaultTrail,setScalperDefaultTrail]= useState(2)        // points
  const [scalperIsPlacing,   setScalperIsPlacing]   = useState(false)
  // Z-index management: last-clicked window comes to front
  const [scalperZIndex,      setScalperZIndex]      = useState(1001)
  const [orderDialogZIndex,  setOrderDialogZIndex]  = useState(1000)
  // Drag state — position stored as {x, y} from bottom-right of viewport
  const scalperDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const scalperElRef   = useRef<HTMLDivElement | null>(null)

  // Derive scalper row from shared chain data
  const scalperRowIndex = Math.max(0, Math.min(qoStrikeList.length - 1, qoAtmIndex + scalperOffset))
  const scalperRow      = qoStrikeList[scalperRowIndex]
  const scalperSymbol   = scalperMode === 0 ? (scalperRow?.ceSym ?? '') : (scalperRow?.peSym ?? '')
  const scalperLotSize  = scalperMode === 0 ? (scalperRow?.ceLotSize ?? 1) : (scalperRow?.peLotSize ?? 1)
  const scalperTickSize = scalperMode === 0 ? (scalperRow?.ceTickSize ?? 0.05) : (scalperRow?.peTickSize ?? 0.05)
  const scalperStrike   = scalperRow?.strike ?? null

  const { data: scalperCeData } = useLiveQuote(scalperRow?.ceSym ?? '', qoExchange, {
    enabled: wsEnabled && scalperOpen && scalperMode === 0 && !!scalperRow?.ceSym,
    mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  const { data: scalperPeData } = useLiveQuote(scalperRow?.peSym ?? '', qoExchange, {
    enabled: wsEnabled && scalperOpen && scalperMode === 1 && !!scalperRow?.peSym,
    mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  const scalperLtp = scalperMode === 0 ? (scalperCeData.ltp ?? null) : (scalperPeData.ltp ?? null)

  // ── Live prices ───────────────────────────────────────────────────────────

  // ── Fetch expiries ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!qoUnderlying) return
    let cancelled = false
    const load = async () => {
      try {
        const exchange = qoUnderlying === 'NIFTY' ? 'NFO' : 'BFO'
        const res = await oiProfileApi.getExpiries(exchange, qoUnderlying)
        if (cancelled) return
        if (res.status === 'success' && res.expiries.length > 0) {
          const todayStr = new Date().toISOString().slice(0, 10)
          const monthMap: Record<string, string> = {
            JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
            JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12',
          }
          const future = res.expiries.filter((e: string) => {
            const parts = e.split('-')
            if (parts.length !== 3) return true
            const mm  = monthMap[parts[1].toUpperCase()] ?? '01'
            const yy  = parts[2].length === 2 ? `20${parts[2]}` : parts[2]
            const iso = `${yy}-${mm}-${parts[0].padStart(2,'0')}`
            return iso >= todayStr
          })
          const valid = future.length > 0 ? future : res.expiries
          setQoExpiries(valid)
          setQoExpiry(prev => valid.includes(prev) ? prev : valid[0])
        }
      } catch (_e) { /* silent */ }
    }
    load()
    return () => { cancelled = true }
  }, [qoUnderlying, qoExchange])

  const convertExpiryForQO = useCallback((expiry: string) => {
    if (!expiry) return ''
    const parts = expiry.split('-')
    if (parts.length === 3) return `${parts[0]}${parts[1].toUpperCase()}${parts[2].slice(-2)}`
    return expiry.replace(/-/g, '').toUpperCase()
  }, [])

  // ── Fetch option chain ────────────────────────────────────────────────────
  useEffect(() => {
    if (!qoExpiry || !qoUnderlying || !apiKey) return
    setQoStrikeList([])
    setQoCeStrikeIndex(0)
    setQoPeStrikeIndex(0)
    setScalperOffset(0) // reset scalper offset on chain reload
    const underlyingExchange = qoUnderlying === 'NIFTY' ? 'NSE_INDEX' : 'BSE_INDEX'
    let cancelled = false
    const fetchChain = async () => {
      try {
        const expiry = convertExpiryForQO(qoExpiry)
        const res = await fetch('/api/v1/optionchain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apikey: apiKey, underlying: qoUnderlying, exchange: underlyingExchange,
            expiry_date: expiry, strike_count: 10,
          }),
        })
        if (!res.ok || cancelled) return
        const json = await res.json()
        if (json?.status !== 'success') return
        const chain = json?.chain ?? []
        if (!chain.length) return
        const mapped = chain.map((s: any) => ({
          strike: s.strike, ceLtp: s.ce?.ltp ?? null, peLtp: s.pe?.ltp ?? null,
          ceSym: s.ce?.symbol ?? '', peSym: s.pe?.symbol ?? '',
          ceLotSize: s.ce?.lotsize ?? 1, peLotSize: s.pe?.lotsize ?? 1,
          ceTickSize: s.ce?.tick_size ?? 0.05, peTickSize: s.pe?.tick_size ?? 0.05,
        }))
        const spot = json?.underlying_ltp ?? 0
        let atmIdx = 0; let minDiff = Infinity
        mapped.forEach((s: any, i: number) => {
          const d = Math.abs(s.strike - spot)
          if (d < minDiff) { minDiff = d; atmIdx = i }
        })
        if (cancelled) return
        setQoStrikeList(mapped); setQoAtmIndex(atmIdx)
        setQoCeStrikeIndex(atmIdx); setQoPeStrikeIndex(atmIdx)
        qoCeUserMovedRef.current = false; qoPeUserMovedRef.current = false
      } catch (_e) { /* silent */ }
    }
    fetchChain()
    return () => { cancelled = true }
  }, [qoUnderlying, qoExpiry, apiKey, convertExpiryForQO])

  useEffect(() => { setWsEnabled(isVisible) }, [isVisible])

  const qoCeRow = qoStrikeList[qoCeStrikeIndex]
  const qoPeRow = qoStrikeList[qoPeStrikeIndex]

  const { data: qoCeData } = useLiveQuote(qoCeRow?.ceSym ?? '', qoExchange, {
    enabled: wsEnabled && !!qoCeRow?.ceSym, mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  const { data: qoPeData } = useLiveQuote(qoPeRow?.peSym ?? '', qoExchange, {
    enabled: wsEnabled && !!qoPeRow?.peSym, mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  const underlyingExchangeForLtp = qoUnderlying === 'NIFTY' ? 'NSE_INDEX' : 'BSE_INDEX'
  const { data: underlyingData } = useLiveQuote(qoUnderlying, underlyingExchangeForLtp, {
    enabled: wsEnabled && !!qoUnderlying, mode: 'LTP', useQuotesFallback: true, pauseWhenHidden: false,
  })
  const qoCeLtp      = qoCeData.ltp       ?? null
  const qoPeLtp      = qoPeData.ltp       ?? null
  const underlyingLtp = underlyingData.ltp ?? null

  // ── Protection created from PlaceOrderDialog or Scalper ──────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent
      const { symbol, exchange, product, sl_price, target_price, trailing_points } = custom.detail as {
        symbol: string; exchange: string; product: string
        sl_price: number | null; target_price: number | null; trailing_points: number | null
      }
      const key = `${symbol}_${exchange}_${product}`
      const updated: PositionProtection = {
        status: 'ACTIVE',
        // Always reset BE — a new order is a fresh position, not a continuation
        break_even_activated: false,
      }
      if (sl_price       != null) { updated.sl_price   = sl_price;  updated.current_sl = sl_price }
      if (target_price   != null)   updated.target_price  = target_price
      if (trailing_points != null)  updated.trailing_points = trailing_points

      // Shield this key from poll overwrites for 15 s (enough for server write to land).
      // Note: PlaceOrderDialog already called /api/protection/save before firing this event.
      // Scalper fires this event and saves separately. Either way, server write is in-flight.
      pendingProtectionsRef.current.set(key, { protection: updated, expiresAt: Date.now() + 30000 })

      // Optimistic local update — table reflects it instantly
      setProtectionState(prev => ({ ...prev, [key]: updated }))
    }
    window.addEventListener('protection-created', handler)
    return () => window.removeEventListener('protection-created', handler)
  }, [])

  // ── Auto-cleanup: delete protection from DB when position closes ──────────
  // When a position's qty becomes 0 (broker confirms close), any ACTIVE or
  // TRIGGERED protection for that key should be removed from the DB so it
  // doesn't resurface on the next login/refresh.
  useEffect(() => {
    if (!positions.length) return
    const protections = protectionStateRef.current
    if (!Object.keys(protections).length) return
    positions.forEach((pos) => {
      if ((Number(pos.quantity) || 0) !== 0) return          // still open
      const key = `${pos.symbol}_${pos.exchange}_${pos.product}`
      const prot = protections[key]
      if (!prot) return
      // Only clean up if there's actually a protection to remove
      const hasProtection =
        prot.sl_price !== undefined ||
        prot.target_price !== undefined ||
        prot.trailing_points !== undefined
      if (!hasProtection) return
      // Remove from local state and DB
      setProtectionState(prev => {
        if (!prev[key]) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
      pendingProtectionsRef.current.delete(key)
      deleteProtectionFromServer(key).catch(() => {})
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions])

  // positions-updated listener registered below after fetchPositions is stable

  // ── Fetch positions ───────────────────────────────────────────────────────

  const fetchPositions = useCallback(async (showRefresh = false) => {
    if (!apiKey) { setIsLoading(false); return }
    if (showRefresh) setIsRefreshing(true)
    try {
      const response = await tradingApi.getPositions(apiKey)
      if (response.status === 'success' && response.data) {
        // No snapshot needed - using simple P&L calculation
        setPositions(response.data); setError(null)
      } else {
        setError(response.message || 'Failed to fetch positions')
      }
    } catch (err) {
      console.error('Failed to fetch positions:', err)
      setError('Failed to fetch positions')
    } finally {
      setIsLoading(false); setIsRefreshing(false)
    }
  }, [apiKey])

  useEffect(() => {
    const handler = () => fetchPositions(true)
    window.addEventListener('positions-updated', handler)
    return () => window.removeEventListener('positions-updated', handler)
  }, [fetchPositions])

  // ── Fetch balance ─────────────────────────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    setBalanceLoading(true)
    try {
      const res  = await fetch('/auth/dashboard-data', { credentials: 'include' })
      const data = await res.json()
      if (data.status === 'success') {
        const bal = parseFloat(data.data.availablecash || '0')
        setOpeningBalance(bal); setEquityPeak(bal)
      }
    } catch { /* silent */ }
    finally { setBalanceLoading(false) }
  }, [])

  useEffect(() => { fetchBalance() }, [fetchBalance])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleCloseAllPositions = useCallback(async () => {
    if (dailyLockout) { showToast.error('Daily loss limit reached — trading locked', 'positions'); return }
    try {
      const response = await tradingApi.closeAllPositions()
      if (response.status === 'success') {
        // Clear all protections from local state and DB — every position is being closed
        const keys = Object.keys(protectionStateRef.current)
        setProtectionState({})
        pendingProtectionsRef.current.clear()
        keys.forEach(key => deleteProtectionFromServer(key).catch(() => {}))
        fetchPositions(true)
      }
      else { showToast.error(response.message || 'Failed to close all positions', 'positions') }
    } catch { showToast.error('Failed to close all positions', 'positions') }
  }, [dailyLockout, fetchPositions])

  const handleClosePosition = useCallback(async (position: Position | PositionWithPnlPercent) => {
    if (dailyLockout) { showToast.error('Daily loss limit reached — trading locked', 'positions'); return }
    try {
      const response = await tradingApi.closePosition(position.symbol, position.exchange, position.product)
      if (response.status === 'success') {
        showToast.success(response.message || `Position closed for ${position.symbol}`, 'positions')
        // Remove protection from local state and DB immediately — don't wait
        // for the position-poll to confirm qty=0, so it never re-appears on refresh.
        const key = `${position.symbol}_${position.exchange}_${position.product}`
        setProtectionState(prev => {
          if (!prev[key]) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
        pendingProtectionsRef.current.delete(key)
        deleteProtectionFromServer(key).catch(() => {})
        fetchPositions(true)
      } else {
        showToast.error(`Close order rejected for ${position.symbol}: ${response.message || 'Unknown error'}`, 'positions')
      }
    } catch {
      showToast.error(`Close order failed for ${position.symbol}`, 'positions')
    }
  }, [dailyLockout, fetchPositions])


  // ── Position polling ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isVisible && POLLING_WHEN_HIDDEN) return
    if (!apiKey) return
    fetchPositions(); lastFetchRef.current = Date.now()
    const intervalMs = isLive ? POLLING_INTERVAL_LIVE : POLLING_INTERVAL_DEFAULT
    const interval = setInterval(() => {
      if (!isVisible && POLLING_WHEN_HIDDEN) return
      fetchPositions(); lastFetchRef.current = Date.now()
    }, intervalMs)
    return () => clearInterval(interval)
  }, [apiKey, isLive, isVisible, fetchPositions])

  useEffect(() => {
    if (!wasHidden || !isVisible) return
    const timeSinceLastFetch = Date.now() - lastFetchRef.current
    if (timeSinceHidden > STALE_DATA_THRESHOLD && timeSinceLastFetch > STALE_DATA_THRESHOLD) {
      setShowStaleWarning(true)
      fetchPositions(); lastFetchRef.current = Date.now()
      const timeout = setTimeout(() => setShowStaleWarning(false), STALE_WARNING_DURATION)
      return () => clearTimeout(timeout)
    }
  }, [wasHidden, isVisible, timeSinceHidden, fetchPositions])

  // ── ATM auto-follow ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!underlyingLtp || qoStrikeList.length === 0) return
    let atmIdx = 0; let minDiff = Infinity
    qoStrikeList.forEach((s, i) => {
      const diff = Math.abs(s.strike - underlyingLtp)
      if (diff < minDiff) { minDiff = diff; atmIdx = i }
    })
    setQoAtmIndex(() => {
      if (!qoCeUserMovedRef.current) setQoCeStrikeIndex(atmIdx)
      if (!qoPeUserMovedRef.current) setQoPeStrikeIndex(atmIdx)
      return atmIdx
    })
  }, [underlyingLtp, qoStrikeList])

  // ── Derived data ──────────────────────────────────────────────────────────
  const filteredPositions = useMemo(() => enhancedPositions.filter((pos) => {
    const qty = pos.quantity || 0
    if (filters.direction.length > 0) {
      if (filters.direction.includes('LONG')  && !filters.direction.includes('SHORT') && !(qty > 0)) return false
      if (filters.direction.includes('SHORT') && !filters.direction.includes('LONG')  && !(qty < 0)) return false
    }
    if (filters.exchange.length > 0 && !filters.exchange.includes(pos.exchange)) return false
    return true
  }), [enhancedPositions, filters])

  const positionsWithPnlPercent = useMemo<PositionWithPnlPercent[]>(() =>
    filteredPositions.map((pos: Position) => {
      const qty      = Number(pos.quantity) || 0
      const avgPrice = Number(pos.average_price) || 0
      const brokerPnl     = Number(pos.pnl) || 0
      const brokerPnlPct  = getPositionPnlPercent(pos)

      // Closed positions always use broker's final realised P&L
      if (qty === 0) return { ...pos, pnl: brokerPnl, pnlPercent: brokerPnlPct, pnlIsLive: true }

      // Get the live LTP from useLivePrice (WS-enhanced)
      const liveLtp = pos.ltp

      // Guard: if LTP is null/undefined, or looks like a strike/spot price,
      // fall back to the broker's P&L so we never display a wildly wrong number.
      if (
        liveLtp == null ||
        !isFinite(liveLtp) ||
        isLtpSuspect(liveLtp, pos.exchange, pos.symbol, avgPrice)
      ) {
        return { ...pos, pnl: brokerPnl, pnlPercent: brokerPnlPct, pnlIsLive: false }
      }

      // Compute live P&L: (livePrice - avgPrice) × qty
      // This is always correct for an open position regardless of re-entries
      // because the WS LTP is the current market price.
      const livePnl    = (liveLtp - avgPrice) * qty
      const investment = Math.abs(avgPrice * qty)
      const livePnlPct = investment > 0 ? (livePnl / investment) * 100 : 0

      return { ...pos, pnl: livePnl, pnlPercent: livePnlPct, pnlIsLive: true }
    })
  , [filteredPositions])

  const stats = useMemo(() => {
    const long     = positionsWithPnlPercent.filter((p) => (p.quantity || 0) > 0).length
    const short    = positionsWithPnlPercent.filter((p) => (p.quantity || 0) < 0).length
    const totalPnl = positionsWithPnlPercent.reduce((sum, p) => sum + (p.pnl || 0), 0)
    return { total: long + short, long, short, totalPnl }
  }, [positionsWithPnlPercent])

  const equity           = openingBalance + stats.totalPnl
  const portfolioSLValue = portfolioSLEnabled ? equityPeak * (1 - portfolioSLPercent / 100) : 0

  useEffect(() => {
    if (!portfolioSLEnabled || !trailEquityEnabled) return
    if (equity <= equityPeak) return
    setEquityPeak(equity)
  }, [equity, portfolioSLEnabled, trailEquityEnabled, equityPeak])

  

  useEffect(() => {
    if (!portfolioSLEnabled || dailyLockout || balanceLoading) return
    const currentLimit = equityPeak * (1 - portfolioSLPercent / 100)
    if (currentLimit <= 0 || equity > currentLimit) return
    handleCloseAllPositions()
    setDailyLockout(true)
    showToast.error(`Portfolio SL hit (${portfolioSLPercent}% drawdown) — All positions closed`, 'positions')
  }, [equity, equityPeak, portfolioSLEnabled, portfolioSLPercent, dailyLockout, balanceLoading, handleCloseAllPositions])

  const sortedPositions = useMemo<PositionWithPnlPercent[]>(() => {
    if (sortColumn === null) return positionsWithPnlPercent
    return [...positionsWithPnlPercent].sort((a, b) => {
      let aVal: string | number; let bVal: string | number
      switch (sortColumn) {
        case 0: aVal = a.symbol; bVal = b.symbol; break
        case 3: aVal = a.quantity || 0; bVal = b.quantity || 0; break
        case 4: aVal = a.average_price || 0; bVal = b.average_price || 0; break
        case 6: aVal = a.pnl || 0; bVal = b.pnl || 0; break
        case 7: aVal = a.pnlPercent; bVal = b.pnlPercent; break
        default: return 0
      }
      if (typeof aVal === 'string') return sortDirection === 'asc' ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal)
      return sortDirection === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
    })
  }, [positionsWithPnlPercent, sortColumn, sortDirection])

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) { setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc') }
    else { setSortColumn(column); setSortDirection('asc') }
  }

  const toggleFilter = (type: keyof FilterState, value: string) => {
    setFilters((prev: FilterState) => {
      const arr = prev[type]; const index = arr.indexOf(value)
      if (index > -1) return { ...prev, [type]: arr.filter((v: string) => v !== value) }
      return { ...prev, [type]: [...arr, value] }
    })
  }

  const clearFilters = () => setFilters({ direction: [], exchange: [] })
  const hasActiveFilters = filters.direction.length > 0 || filters.exchange.length > 0

  // ── Inline edit handlers ──────────────────────────────────────────────────
  const handleInlineEdit = useCallback(
    (positionKey: string, field: 'sl' | 'target' | 'trail', currentValue?: number, position?: PositionWithPnlPercent) => {
      setEditingField({ positionKey, field, value: currentValue?.toString() || '', position: position ?? null })
    }, []
  )
  const handleInlineCancel = useCallback(() => setEditingField(null), [])

  const handleInlineSave = useCallback(async () => {
    if (!editingField) return
    const { positionKey, field, value } = editingField
    const numValue = parseFloat(value)
    const currentProtection = protectionState[positionKey] || {}
    let protectionForSave: PositionProtection | undefined
    let shouldDelete = false

    if (value === '' || isNaN(numValue)) {
      const next = { ...currentProtection }
      if (field === 'sl')     { delete next.sl_price; delete next.current_sl }
      if (field === 'target') { delete next.target_price }
      if (field === 'trail')  { delete next.trailing_points }
      if (next.sl_price === undefined && next.target_price === undefined && next.trailing_points === undefined) {
        shouldDelete = true
      } else {
        protectionForSave = next
      }
    } else {
      if (field === 'sl') {
        protectionForSave = {
          ...currentProtection,
          sl_price: numValue,
          current_sl: numValue,
          status: 'ACTIVE',
          // Reset BE state — user is setting a fresh SL, treat as new protection
          break_even_activated: false,
        }
      } else if (field === 'target') {
        const pos = editingField.position
        if (pos && pos.ltp) {
          const isLong = pos.quantity > 0
          const trailPoints = (protectionState[positionKey]?.trailing_points) ?? 0
          const fallbackOffset = trailPoints > 0 ? trailPoints : 10
          if (isLong && numValue <= pos.ltp) {
            const autoTgt = roundToTick(pos.ltp + fallbackOffset)
            showToast.error(`Target too low — auto-set to ₹${autoTgt.toFixed(2)} (LTP + ${fallbackOffset} pts)`, 'positions')
            setEditingField({ ...editingField, value: autoTgt.toString() }); return
          }
          if (!isLong && numValue >= pos.ltp) {
            const autoTgt = roundToTick(pos.ltp - fallbackOffset)
            showToast.error(`Target too high — auto-set to ₹${autoTgt.toFixed(2)} (LTP - ${fallbackOffset} pts)`, 'positions')
            setEditingField({ ...editingField, value: autoTgt.toString() }); return
          }
        }
        protectionForSave = { ...currentProtection, target_price: numValue, status: 'ACTIVE' }
      } else if (field === 'trail') {
        const pos = editingField.position
        const hasSL = currentProtection.current_sl !== undefined || currentProtection.sl_price !== undefined
        const autoSL = (!hasSL && pos && pos.ltp)
          ? roundToTick(pos.quantity > 0 ? pos.ltp - 2 * numValue : pos.ltp + 2 * numValue)
          : undefined
        protectionForSave = {
          ...currentProtection, trailing_points: numValue, best_price: pos?.ltp,
          ...(autoSL !== undefined && { current_sl: autoSL, sl_price: autoSL }),
          status: 'ACTIVE',
        }
      }
    }

    // Shield from poll overwrites for 10 s while the server write lands.
    // Without this the 2-second poll reads stale server data and reverts the change.
    if (!shouldDelete && protectionForSave) {
      pendingProtectionsRef.current.set(positionKey, {
        protection: protectionForSave,
        expiresAt: Date.now() + 10000,
      })
    } else if (shouldDelete) {
      pendingProtectionsRef.current.delete(positionKey)
    }

    setProtectionState((prev: Record<string, PositionProtection>) => {
      const updated = { ...prev }
      if (shouldDelete) delete updated[positionKey]
      else if (protectionForSave) updated[positionKey] = protectionForSave
      return updated
    })

    if (shouldDelete) {
      await deleteProtectionFromServer(positionKey)
    } else if (protectionForSave) {
      await saveProtectionToServer(positionKey, protectionForSave)
    }

    setEditingField(null)
  }, [editingField, protectionState])


  // ── Scalper: direct order placement (no dialog) ───────────────────────────
  // Places a market order immediately, then registers SL + trailing protection
  // exactly the same way PlaceOrderDialog does via the 'protection-created' event.
  const handleScalperOrder = useCallback(async (action: 'BUY' | 'SELL') => {
    if (!scalperSymbol || dailyLockout || scalperIsPlacing) return
    setScalperIsPlacing(true)

    const qty = scalperLots * scalperLotSize

    try {
      const response = await tradingApi.placeOrder({
        apikey:        apiKey!,
        strategy:      '',
        symbol:        scalperSymbol,
        exchange:      qoExchange,
        action,
        product:       'NRML',
        pricetype:     'MARKET',
        quantity:      qty,
        price:         0,
        trigger_price: 0,
      })

      if (response.status !== 'success') {
        showToast.error(`Scalper order failed: ${response.message ?? 'Unknown error'}`, 'positions')
        return
      }

      showToast.success(`${action} ${qty} \u00d7 ${scalperSymbol} sent \u2713`, 'positions')

      // Register SL + trail protection immediately (same flow as PlaceOrderDialog)
      // Optimistic local update FIRST so the table reflects it instantly,
      // then save to server in the background (non-blocking).
      const ltp = scalperLtp
      if (ltp != null && (scalperDefaultSL > 0 || scalperDefaultTrail > 0)) {
        const isLong  = action === 'BUY'
        const slPrice = scalperDefaultSL > 0
          ? roundToTick(isLong ? ltp - scalperDefaultSL : ltp + scalperDefaultSL, scalperTickSize)
          : undefined

        const protection: PositionProtection = {
          status: 'ACTIVE',
          break_even_activated: false,  // always reset for a fresh order
        }
        if (slPrice !== undefined) { protection.sl_price = slPrice; protection.current_sl = slPrice }
        if (scalperDefaultTrail > 0) protection.trailing_points = scalperDefaultTrail

        const key = `${scalperSymbol}_${qoExchange}_NRML`

        // Shield from poll overwrites for 30 s while server write lands
        pendingProtectionsRef.current.set(key, { protection, expiresAt: Date.now() + 30000 })

        // 1. Update local state immediately — visible in the table right away
        setProtectionState(prev => ({ ...prev, [key]: protection }))

        // 2. Fire the custom event so the protection-created listener also picks it up
        window.dispatchEvent(new CustomEvent('protection-created', {
          detail: {
            symbol:          scalperSymbol,
            exchange:        qoExchange,
            product:         'NRML',
            sl_price:        slPrice ?? null,
            target_price:    null,
            trailing_points: scalperDefaultTrail > 0 ? scalperDefaultTrail : null,
          },
        }))

        // 3. Persist to server in background — don't await so UI stays snappy
        saveProtectionToServer(key, protection).catch(err =>
          console.error('Scalper protection save failed', err)
        )
      }

      // Staggered refreshes — broker confirmation can be slow, so we poll
      // at 1.5 s, 3 s, and 6 s to catch whichever tick the position lands on.
      setTimeout(() => fetchPositions(true), 1500)
      setTimeout(() => fetchPositions(true), 3000)
      setTimeout(() => fetchPositions(true), 6000)
    } catch (err) {
      console.error('Scalper order error', err)
      showToast.error('Scalper order failed \u2014 see console', 'positions')
    } finally {
      setScalperIsPlacing(false)
    }
  }, [
    scalperSymbol, scalperLots, scalperLotSize, scalperTickSize,
    scalperLtp, scalperDefaultSL, scalperDefaultTrail,
    qoExchange, apiKey, dailyLockout, scalperIsPlacing, fetchPositions,
  ])

  // ── CSV export ────────────────────────────────────────────────────────────
  const exportToCSV = useCallback(() => {
    const headers = ['Symbol', 'Exchange', 'Product', 'Quantity', 'Avg Price', 'LTP', 'P&L', 'P&L %']
    const rows = positionsWithPnlPercent.map((p) => [
      sanitizeCSV(p.symbol), sanitizeCSV(p.exchange), sanitizeCSV(p.product),
      sanitizeCSV(p.quantity), sanitizeCSV(p.average_price), sanitizeCSV(p.ltp),
      sanitizeCSV(p.pnl), sanitizeCSV(p.pnlPercent),
    ])
    const csv  = [headers, ...rows].map((row) => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `positions_${new Date().toISOString().split('T')[0]}.csv`
    a.click(); URL.revokeObjectURL(url)
  }, [positionsWithPnlPercent])

  const handlePortfolioSLPercentChange = (value: string) => {
    const num = parseFloat(value)
    if (isNaN(num)) return
    setPortfolioSLPercent(Math.max(MIN_PORTFOLIO_SL_PERCENT, Math.min(MAX_PORTFOLIO_SL_PERCENT, num)))
  }

  const isProfit = (value: number) => value >= 0

  // ── Sub-components ────────────────────────────────────────────────────────
  const FilterChip = ({ type, value, label }: { type: keyof FilterState; value: string; label: string }) => (
    <Button
      variant={filters[type].includes(value) ? 'default' : 'outline'}
      size="sm"
      className={cn('rounded-full', filters[type].includes(value) && 'bg-pink-500 hover:bg-pink-600')}
      onClick={() => toggleFilter(type, value)}
    >
      {label}
    </Button>
  )

  const SortableHeader = ({ column, label, className }: { column: SortColumn; label: string; className?: string }) => (
    <TableHead className={cn('cursor-pointer hover:bg-muted/50 select-none', className)} onClick={() => handleSort(column)}>
      <div className={cn('flex items-center gap-1 w-full', className?.includes('text-right') && 'justify-end', className?.includes('text-center') && 'justify-center')}>
        {label}<ArrowUpDown className="h-3 w-3 opacity-50" />
      </div>
    </TableHead>
  )

  // ─────────────────────────── Render ───────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Daily Lockout Banner */}
      {dailyLockout && (
        <Alert variant="destructive" className="border-2">
          <Shield className="h-5 w-5" />
          <AlertDescription className="text-base font-semibold">
            🔒 Daily Lockout Active — Trading is disabled. Portfolio stop-loss has been triggered.
            <Button variant="ghost" size="sm" className="ml-4" onClick={() => setDailyLockout(false)}>Reset Lockout</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Stale data warning */}
      {showStaleWarning && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Data may be stale — refreshing positions...</AlertDescription>
        </Alert>
      )}

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 px-6 py-0">
        {/* Left: Title + badges + stats */}
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Positions</h1>
              {isPaused ? (
                <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/30 gap-1">
                  <Pause className="h-3 w-3" />Paused
                </Badge>
              ) : isLive ? (
                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 gap-1">
                  <Radio className="h-3 w-3 animate-pulse" />Live
                </Badge>
              ) : null}

            </div>
          </div>

          <div className="w-px h-8 bg-border" />
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground leading-tight">Open</span>
            <span className="text-2xl font-bold leading-tight">{stats.total}</span>
          </div>
          <div className="w-px h-8 bg-border" />
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground leading-tight">Long</span>
            <span className="text-2xl font-bold leading-tight text-green-600">{stats.long}</span>
          </div>
          <div className="w-px h-8 bg-border" />
          <div className="flex flex-col">
            <span className="text-xs text-muted-foreground leading-tight">Short</span>
            <span className="text-2xl font-bold leading-tight text-red-600">{stats.short}</span>
          </div>
        </div>

        {/* Center: Total P&L */}
        <div className="flex flex-col items-center gap-0.5 sm:flex-1 sm:text-center">
          <span className="text-xs text-muted-foreground leading-tight">Total P&amp;L</span>
          <span className={cn('text-2xl font-bold leading-tight', isProfit(stats.totalPnl) ? 'text-green-600' : 'text-red-600')}>
            {formatCurrency(stats.totalPnl)}
          </span>
        </div>

        {/* Right: Buttons */}
        <div className="flex items-center gap-2 flex-wrap sm:ml-auto">

          {/* ── Scalper toggle ── */}
          <Button
            variant={scalperOpen ? 'default' : 'outline'}
            size="sm"
            className={cn(scalperOpen && 'bg-violet-600 hover:bg-violet-700 text-white')}
            onClick={() => setScalperOpen(v => !v)}
            disabled={dailyLockout}
          >
            <Zap className="h-4 w-4 mr-2" />Scalper
          </Button>

          {/* ── Settings (contains Portfolio SL + default lot + filters) ── */}
          <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
            <DialogTrigger asChild>
              <Button
                variant={hasActiveFilters || portfolioSLEnabled ? 'default' : 'outline'}
                size="sm"
                className={cn('relative', (hasActiveFilters || portfolioSLEnabled) && 'bg-pink-500 hover:bg-pink-600')}
              >
                <Settings2 className="h-4 w-4 mr-2" />Settings
                {(hasActiveFilters || portfolioSLEnabled) && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full" />
                )}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Position Settings</DialogTitle>
                <DialogDescription></DialogDescription>
              </DialogHeader>

              <div className="space-y-6 py-4">

                {/* ── Portfolio SL ── */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4 text-amber-500 shrink-0" />
                      <div>
                        <p className="text-sm font-medium">Enable Portfolio SL</p>

                      </div>
                    </div>
                    <Switch checked={portfolioSLEnabled} onCheckedChange={setPortfolioSLEnabled} disabled={dailyLockout} />
                  </div>

                  {portfolioSLEnabled && (
                    <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <p className="text-xs text-muted-foreground">Opening Balance</p>
                          <p className="font-mono font-bold">{formatCurrency(openingBalance)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Current Equity</p>
                          <p className={cn('font-mono font-bold', isProfit(equity - openingBalance) ? 'text-green-600' : 'text-red-600')}>
                            {formatCurrency(equity)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">SL Trigger</p>
                          <p className="font-mono font-bold text-red-600">{formatCurrency(portfolioSLValue)}</p>
                        </div>
                        {trailEquityEnabled && (
                          <div>
                            <p className="text-xs text-muted-foreground">Equity Peak</p>
                            <p className="font-mono font-bold">{formatCurrency(equityPeak)}</p>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-amber-500/20">
                        <div className="flex items-center gap-2">
                          <Switch checked={trailEquityEnabled} onCheckedChange={setTrailEquityEnabled} disabled={dailyLockout} />
                          <Label className="text-xs cursor-pointer">Trail Equity Peak</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-xs">Drawdown %</Label>
                          <Input
                            type="number" min={MIN_PORTFOLIO_SL_PERCENT} max={MAX_PORTFOLIO_SL_PERCENT}
                            value={portfolioSLPercent} onChange={(e) => handlePortfolioSLPercentChange(e.target.value)}
                            className="w-20 h-7 text-xs" disabled={dailyLockout}
                          />
                          <span className="text-xs text-muted-foreground">({MIN_PORTFOLIO_SL_PERCENT}–{MAX_PORTFOLIO_SL_PERCENT}%)</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="border-t" />

                {/* ── Scalper Defaults ── */}
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Scalper Defaults
                  </Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground w-20 shrink-0">SL pts</Label>
                      <Input
                        type="number" min={0} step={1} value={scalperDefaultSL}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setScalperDefaultSL(v) }}
                        className="h-7 text-xs"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground w-20 shrink-0">Trail pts</Label>
                      <Input
                        type="number" min={0} step={1} value={scalperDefaultTrail}
                        onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setScalperDefaultTrail(v) }}
                        className="h-7 text-xs"
                      />
                    </div>
                  </div>

                </div>

                <div className="border-t" />

                {/* Brokerage & Taxes Section */}
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Brokerage & Taxes
                  </Label>
                  <div className="space-y-3 rounded-lg border p-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-muted-foreground">Flat Brokerage (₹)</Label>
                        <Input
                          type="number"
                          min={0}
                          step={5}
                          value={brokerageSettings.flat_brokerage}
                          onChange={(e) => setBrokerageSettings(prev => ({
                            ...prev,
                            flat_brokerage: parseFloat(e.target.value) || 0
                          }))}
                          className="h-8"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">Per order leg</p>
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Tax (%)</Label>
                        <Input
                          type="number"
                          min={0}
                          max={1}
                          step={0.0001}
                          value={brokerageSettings.tax_percent}
                          onChange={(e) => setBrokerageSettings(prev => ({
                            ...prev,
                            tax_percent: parseFloat(e.target.value) || 0
                          }))}
                          className="h-8"
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">Exchange transaction tax</p>
                      </div>
                    </div>
                    <Button 
                      size="sm" 
                      onClick={saveBrokerageSettings}
                      disabled={brokerageLoading}
                      className="w-full"
                    >
                      {brokerageLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Save Brokerage Settings
                    </Button>
                  </div>
                </div>

                {/* ── Direction filter ── */}
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Direction</Label>
                  <div className="flex flex-wrap gap-2">
                    <FilterChip type="direction" value="LONG" label="Long" />
                    <FilterChip type="direction" value="SHORT" label="Short" />
                  </div>
                </div>

                {/* ── Exchange filter ── */}
                <div className="space-y-3">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Exchange</Label>
                  <div className="flex flex-wrap gap-2">
                    <FilterChip type="exchange" value="NSE" label="NSE" />
                    <FilterChip type="exchange" value="BSE" label="BSE" />
                    <FilterChip type="exchange" value="NFO" label="NFO" />
                    <FilterChip type="exchange" value="BFO" label="BFO" />
                    <FilterChip type="exchange" value="MCX" label="MCX" />
                    <FilterChip type="exchange" value="CDS" label="CDS" />
                  </div>
                </div>

              </div>

              <DialogFooter>
                <Button variant="ghost" onClick={clearFilters}>Clear Filters</Button>
                <Button onClick={() => setSettingsOpen(false)}>Done</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Button variant="outline" size="sm" onClick={() => fetchPositions(true)} disabled={isRefreshing}>
            <RefreshCw className={cn('h-4 w-4 mr-2', isRefreshing && 'animate-spin')} />Refresh
          </Button>

          <Button variant="outline" size="sm" onClick={exportToCSV}>
            <Download className="h-4 w-4 mr-2" />Export
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" disabled={stats.total === 0 || dailyLockout}>
                <X className="h-4 w-4 mr-2" />Close All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close All Positions?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will close all {stats.total} open positions at market price. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleCloseAllPositions}>Close All</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Active Filters Bar */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">Active Filters:</span>
          {filters.direction.map((v) => (
            <Badge key={v} variant="secondary" className="bg-pink-500/10 text-pink-600 border-pink-500/30">{v}</Badge>
          ))}
          {filters.exchange.map((v) => (
            <Badge key={v} variant="secondary" className="bg-pink-500/10 text-pink-600 border-pink-500/30">{v}</Badge>
          ))}
          <Button variant="outline" size="sm" className="text-red-500 border-red-500/50 hover:bg-red-500/10" onClick={clearFilters}>Clear All</Button>
        </div>
      )}

            {/* ── Quick Order Panel ── */}
      <div className="flex flex-col sm:flex-row flex-wrap items-center gap-2 sm:gap-4 px-4 py-2 bg-background border rounded-md">
        {/* Row 1 (mobile full width): Underlying + Expiry + Spot price */}
        <div className="flex flex-wrap items-center justify-start gap-2 sm:gap-4 w-full sm:w-auto">
          <Select value={qoUnderlying} onValueChange={v => setQoUnderlying(v as 'NIFTY' | 'SENSEX')}>
            <SelectTrigger className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{QO_UNDERLYINGS.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={qoExpiry} onValueChange={setQoExpiry} disabled={qoExpiries.length === 0}>
            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue placeholder="Expiry" /></SelectTrigger>
            <SelectContent>{qoExpiries.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
          </Select>
          {/* Spot price – smaller (20px), now inside first row */}
          {underlyingLtp != null && (
            <span className="text-xl px-2 font-bold font-mono tabular-nums shrink-0 sm:ml-auto">
              {underlyingLtp.toFixed(2)}
            </span>
          )}
        </div>

        {/* Row 2 (mobile full width): CE controls */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <span className="text-xs font-bold text-green-500">CE</span>
          <Button variant="ghost" size="sm" className="h-6 w-5 p-0" disabled={qoCeStrikeIndex <= 0}
            onClick={() => { qoCeUserMovedRef.current = true; setQoCeStrikeIndex(i => Math.max(0, i-1)) }}>
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Select value={qoCeRow?.strike?.toString() ?? ''}
            onValueChange={v => { qoCeUserMovedRef.current = true; setQoCeStrikeIndex(qoStrikeList.findIndex(s => s.strike === Number(v))) }}>
            <SelectTrigger className="h-7 w-28 text-xs font-mono"><SelectValue placeholder="Strike" /></SelectTrigger>
            <SelectContent>{qoStrikeList.map(s => <SelectItem key={s.strike} value={s.strike.toString()}>{s.strike}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-6 w-5 p-0" disabled={qoCeStrikeIndex >= qoStrikeList.length - 1}
            onClick={() => { qoCeUserMovedRef.current = true; setQoCeStrikeIndex(i => Math.min(qoStrikeList.length-1, i+1)) }}>
            <ChevronDown className="h-3 w-3" />
          </Button>
          <span className="text-xs font-mono font-bold text-green-500 w-16 text-right">
            {qoCeLtp != null ? `₹${qoCeLtp.toFixed(2)}` : '₹0.00'}
          </span>
          {qoCeStrikeIndex === qoAtmIndex && <Badge variant="outline" className="text-[9px] px-1 h-4">ATM</Badge>}
          {qoCeStrikeIndex > qoAtmIndex && <Badge variant="outline" className="text-[9px] px-1 h-4 text-amber-500 border-amber-500/40">OTM</Badge>}
          {qoCeStrikeIndex < qoAtmIndex && <Badge variant="outline" className="text-[9px] px-1 h-4 text-muted-foreground">ITM</Badge>}
          <Button size="sm" className="h-7 px-3 bg-green-600 hover:bg-green-700 text-white text-xs font-bold"
            disabled={!qoCeRow?.ceSym || dailyLockout}
            onClick={() => openOrderDialog(qoCeRow!.ceSym, qoExchange, 'BUY', 'NRML', qoCeRow!.ceLotSize, qoCeRow!.ceLotSize, qoCeRow!.ceTickSize)}>
            Buy CE
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-3 border-red-500 text-red-500 hover:bg-red-500/10 text-xs font-bold"
            disabled={!qoCeRow?.ceSym || dailyLockout}
            onClick={() => openOrderDialog(qoCeRow!.ceSym, qoExchange, 'SELL', 'NRML', qoCeRow!.ceLotSize, qoCeRow!.ceLotSize, qoCeRow!.ceTickSize)}>
            Sell CE
          </Button>
        </div>

        {/* Row 3 (mobile full width): PE controls, right-aligned on desktop */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto sm:ml-auto">
          <span className="text-xs font-bold text-red-500">PE</span>
          <Button variant="ghost" size="sm" className="h-6 w-5 p-0" disabled={qoPeStrikeIndex <= 0}
            onClick={() => { qoPeUserMovedRef.current = true; setQoPeStrikeIndex(i => Math.max(0, i-1)) }}>
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Select value={qoPeRow?.strike?.toString() ?? ''}
            onValueChange={v => { qoPeUserMovedRef.current = true; setQoPeStrikeIndex(qoStrikeList.findIndex(s => s.strike === Number(v))) }}>
            <SelectTrigger className="h-7 w-28 text-xs font-mono"><SelectValue placeholder="Strike" /></SelectTrigger>
            <SelectContent>{qoStrikeList.map(s => <SelectItem key={s.strike} value={s.strike.toString()}>{s.strike}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-6 w-5 p-0" disabled={qoPeStrikeIndex >= qoStrikeList.length - 1}
            onClick={() => { qoPeUserMovedRef.current = true; setQoPeStrikeIndex(i => Math.min(qoStrikeList.length-1, i+1)) }}>
            <ChevronDown className="h-3 w-3" />
          </Button>
          <span className="text-xs font-mono font-bold text-red-500 w-16 text-right">
            {qoPeLtp != null ? `₹${qoPeLtp.toFixed(2)}` : '₹0.00'}
          </span>
          {qoPeStrikeIndex === qoAtmIndex && <Badge variant="outline" className="text-[9px] px-1 h-4">ATM</Badge>}
          {qoPeStrikeIndex < qoAtmIndex && <Badge variant="outline" className="text-[9px] px-1 h-4 text-amber-500 border-amber-500/40">OTM</Badge>}
          {qoPeStrikeIndex > qoAtmIndex && <Badge variant="outline" className="text-[9px] px-1 h-4 text-muted-foreground">ITM</Badge>}
          <Button size="sm" className="h-7 px-3 bg-green-600 hover:bg-green-700 text-white text-xs font-bold"
            disabled={!qoPeRow?.peSym || dailyLockout}
            onClick={() => openOrderDialog(qoPeRow!.peSym, qoExchange, 'BUY', 'NRML', qoPeRow!.peLotSize, qoPeRow!.peLotSize, qoPeRow!.peTickSize)}>
            Buy PE
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-3 border-red-500 text-red-500 hover:bg-red-500/10 text-xs font-bold"
            disabled={!qoPeRow?.peSym || dailyLockout}
            onClick={() => openOrderDialog(qoPeRow!.peSym, qoExchange, 'SELL', 'NRML', qoPeRow!.peLotSize, qoPeRow!.peLotSize, qoPeRow!.peTickSize)}>
            Sell PE
          </Button>
        </div>
      </div>

      {/* Positions Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <Alert variant="destructive" className="m-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : stats.total === 0 && filteredPositions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <p className="text-lg font-medium">No open positions</p>
              <p className="text-sm">Your active positions will appear here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <SortableHeader column={0} label="Symbol"  className="w-[200px] text-center" />
                    <TableHead className="w-[80px] text-center">Exchange</TableHead>
                    <TableHead className="w-[80px] text-center">Product</TableHead>
                    <SortableHeader column={3} label="Qty"     className="w-[80px] text-center" />
                    <SortableHeader column={4} label="Avg"     className="w-[90px] text-center" />
                    <TableHead className="w-[90px] text-center">LTP</TableHead>
                    <SortableHeader column={6} label="P&L"     className="w-[150px] text-center" />
                    <SortableHeader column={7} label="P&L %"   className="w-[100px] text-center" />
                    <TableHead className="w-[100px] text-center">SL</TableHead>
                    <TableHead className="w-[100px] text-center">Target</TableHead>
                    <TableHead className="w-[100px] text-center">Trail</TableHead>
                    <TableHead className="w-[110px] text-center">Status</TableHead>
                    <TableHead className="w-[100px] text-center">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedPositions.map((position) => {
                    const pnlPercent = position.pnlPercent;
                    return (
                        <TableRow key={`${position.symbol}-${position.exchange}-${position.product}`}>
                        <TableCell className="w-[200px] font-medium text-center">{position.symbol}</TableCell>
                        <TableCell className="w-[80px] text-center">
                          <Badge variant="outline" className={EXCHANGE_COLORS[position.exchange] || ''}>{position.exchange}</Badge>
                        </TableCell>
                        <TableCell className="w-[80px] text-center">
                          <Badge variant="outline" className={PRODUCT_COLORS[position.product] || ''}>{position.product}</Badge>
                        </TableCell>
                        <TableCell className={cn('w-[80px] text-center font-medium', position.quantity > 0 ? 'text-green-600' : 'text-red-600')}>
                          {position.quantity}
                        </TableCell>
                        <TableCell className="w-[90px] text-center font-mono">{formatCurrency(position.average_price)}</TableCell>
                        <TableCell className="w-[90px] text-center font-mono">
                          {(() => {
                            const ltp = position.ltp
                            if (ltp === undefined || ltp === null) return <span className="text-muted-foreground">-</span>
                            // Use the shared guard: catches both the "round-number strike"
                            // and the "spot price leaked into option LTP" broker bugs.
                            if (isLtpSuspect(ltp, position.exchange, position.symbol, Number(position.average_price) || 0)) {
                              return <span className="text-muted-foreground text-xs">—</span>
                            }
                            return <span>{formatCurrency(ltp)}</span>
                          })()}
                        </TableCell>
                        <TableCell className={cn('w-[150px] text-center font-medium', isProfit(position.pnl) ? 'text-green-600' : 'text-red-600')}>
                          {!position.pnlIsLive && position.pnl === 0 && (position.quantity ?? 0) !== 0
                            ? <span className="text-muted-foreground text-xs">—</span>
                            : formatCurrency(position.pnl)}
                        </TableCell>
                        <TableCell className={cn(
                          'w-[100px] text-center',
                          isProfit(pnlPercent) ? 'text-green-600' : 'text-red-600'
                        )}>
                          {!position.pnlIsLive && position.pnl === 0 && (position.quantity ?? 0) !== 0
                            ? <span className="text-muted-foreground text-xs">—</span>
                            : <>{pnlPercent >= 0 ? '+' : ''}{pnlPercent.toFixed(2)}%</>}
                        </TableCell>

                        {/* SL */}
                        <TableCell className="w-[100px] text-center">
                          {(() => {
                            const key        = getPositionKey(position)
                            const protection  = protectionState[key]
                            const isEditing   = editingField?.positionKey === key && editingField?.field === 'sl'
                            const isClosed    = isPositionClosed(position)
                            const activeSL    = protection?.current_sl ?? protection?.sl_price
                            if (isEditing && !isClosed) {
                              return (
                                <div className="flex items-center justify-center gap-1">
                                  <Input type="number" step="1.0" value={editingField.value}
                                    onChange={(e) => setEditingField({ ...editingField, value: e.target.value })}
                                    onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setEditingField(f => f ? { ...f, value: n.toFixed(2) } : f) }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') handleInlineSave(); if (e.key === 'Escape') handleInlineCancel() }}
                                    className="h-7 w-20 text-xs text-center" autoFocus />
                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleInlineSave}><Check className="h-3 w-3 text-green-600" /></Button>
                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleInlineCancel}><XIcon className="h-3 w-3 text-red-600" /></Button>
                                </div>
                              )
                            }
                            return (
                              <div
                                className={cn('px-2 py-1 rounded text-xs font-mono', !isClosed && 'cursor-pointer hover:bg-muted/50', isClosed && 'opacity-60 cursor-not-allowed')}
                                onClick={() => { if (!isClosed) handleInlineEdit(key, 'sl', activeSL, position) }}
                                title={isClosed ? 'Position closed' : 'Click to set Stop Loss'}
                              >
                                {activeSL !== undefined && activeSL !== null
                                  ? <span className={cn('font-semibold', protection?.status === 'ACTIVE' && 'text-red-600')}>₹{activeSL.toFixed(2)}</span>
                                  : <span className="text-muted-foreground">-</span>}
                              </div>
                            )
                          })()}
                        </TableCell>

                        {/* Target */}
                        <TableCell className="w-[100px] text-center">
                          {(() => {
                            const key        = getPositionKey(position)
                            const protection  = protectionState[key]
                            const isEditing   = editingField?.positionKey === key && editingField?.field === 'target'
                            const isClosed    = isPositionClosed(position)
                            const targetValue = protection?.target_price
                            if (isEditing && !isClosed) {
                              return (
                                <div className="flex items-center justify-end gap-1">
                                  <Input type="number" step="1.0" value={editingField.value}
                                    onChange={(e) => setEditingField({ ...editingField, value: e.target.value })}
                                    onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setEditingField(f => f ? { ...f, value: n.toFixed(2) } : f) }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') handleInlineSave(); if (e.key === 'Escape') handleInlineCancel() }}
                                    className="h-7 w-20 text-xs text-left" autoFocus />
                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleInlineSave}><Check className="h-3 w-3 text-green-600" /></Button>
                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleInlineCancel}><XIcon className="h-3 w-3 text-red-600" /></Button>
                                </div>
                              )
                            }
                            return (
                              <div
                                className={cn('px-2 py-1 rounded text-xs font-mono', !isClosed && 'cursor-pointer hover:bg-muted/50', isClosed && 'opacity-60 cursor-not-allowed')}
                                onClick={() => { if (!isClosed) handleInlineEdit(key, 'target', targetValue, position) }}
                                title={isClosed ? 'Position closed' : 'Click to set Target'}
                              >
                                {targetValue !== undefined && targetValue !== null
                                  ? <span className={cn('font-semibold', protection?.status === 'ACTIVE' && 'text-green-600')}>₹{targetValue.toFixed(2)}</span>
                                  : <span className="text-muted-foreground">-</span>}
                              </div>
                            )
                          })()}
                        </TableCell>

                        {/* Trail */}
                        <TableCell className="w-[100px] text-center">
                          {(() => {
                            const key        = getPositionKey(position)
                            const protection  = protectionState[key]
                            const isEditing   = editingField?.positionKey === key && editingField?.field === 'trail'
                            const isClosed    = isPositionClosed(position)
                            const trailValue  = protection?.trailing_points
                            if (isEditing && !isClosed) {
                              return (
                                <div className="flex items-center justify-end gap-1">
                                  <Input type="number" step="1.0" min="0" value={editingField.value}
                                    onChange={(e) => setEditingField({ ...editingField, value: e.target.value })}
                                    onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setEditingField(f => f ? { ...f, value: n.toFixed(2) } : f) }}
                                    onKeyDown={(e) => { if (e.key === 'Enter') handleInlineSave(); if (e.key === 'Escape') handleInlineCancel() }}
                                    className="h-7 w-20 text-xs text-left" autoFocus />
                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleInlineSave}><Check className="h-3 w-3 text-green-600" /></Button>
                                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleInlineCancel}><XIcon className="h-3 w-3 text-red-600" /></Button>
                                </div>
                              )
                            }
                            return (
                              <div
                                className={cn('px-2 py-1 rounded text-xs font-mono', !isClosed && 'cursor-pointer hover:bg-muted/50', isClosed && 'opacity-60 cursor-not-allowed')}
                                onClick={() => { if (!isClosed) handleInlineEdit(key, 'trail', trailValue, position) }}
                                title={isClosed ? 'Position closed' : 'Click to set Trailing points'}
                              >
                                {trailValue !== undefined && trailValue > 0
                                  ? <span className="font-semibold text-amber-600">{trailValue.toFixed(2)}</span>
                                  : <span className="text-muted-foreground">-</span>}
                              </div>
                            )
                          })()}
                        </TableCell>

                        {/* Status */}
                        <TableCell className="w-[110px] text-center">
                          {(() => {
                            const key        = getPositionKey(position)
                            const protection  = protectionState[key]
                            const closed      = isPositionClosed(position)
                            if (closed) return <Badge variant="outline" className="bg-slate-500/10 text-slate-600 border-slate-500/30 text-xs">Closed</Badge>
                            if (!protection) return <span className="text-xs text-muted-foreground">-</span>
                            if (protection.status === 'TRIGGERED') return <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/30 text-xs">Triggered</Badge>
                            if (protection.status === 'CLOSED')    return <Badge variant="outline" className="bg-slate-500/10 text-slate-600 border-slate-500/30 text-xs">Closed</Badge>
                            const hasProtection = protection.sl_price !== undefined || protection.target_price !== undefined || protection.trailing_points !== undefined
                            if (protection.status === 'ACTIVE' && hasProtection) {
                              if (protection.break_even_activated) {
                                return <Badge variant="outline" className="bg-blue-500/10 text-blue-600 border-blue-500/30 text-xs"><Shield className="h-3 w-3 mr-1" />Break-Even</Badge>
                              }
                              return <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/30 text-xs"><Shield className="h-3 w-3 mr-1" />Protected</Badge>
                            }
                            return <span className="text-xs text-muted-foreground">-</span>
                          })()}
                        </TableCell>

                        {/* Action */}
                        <TableCell className="w-[100px] text-center">
                          <div className="flex items-center justify-center gap-1">
                            <Button variant="ghost" size="sm" className="text-green-600 hover:text-green-700 hover:bg-green-500/10 px-2"
                              title="Place order for this symbol"
                              onClick={() => {
                                const lotSize = getLotSize(position.symbol, position.exchange)
                                openOrderDialog(position.symbol, position.exchange, 'BUY', position.product as 'MIS' | 'NRML' | 'CNC', lotSize, lotSize, 0.05)
                              }}
                              disabled={dailyLockout}>
                              <Plus className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10 px-2"
                              title="Close position"
                              onClick={() => handleClosePosition(position)}
                              disabled={dailyLockout}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={6} className="text-right text-muted-foreground">Total P&L:</TableCell>
                    <TableCell className={cn('w-[140px] text-right font-bold', isProfit(stats.totalPnl) ? 'text-green-600' : 'text-red-600')}>
                      {stats.totalPnl >= 0 ? '+' : ''}{formatCurrency(stats.totalPnl)}
                    </TableCell>
                    <TableCell colSpan={6} />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Place Order Dialog — z-index managed so click brings it to front */}
      <div
        onMouseDown={() => setOrderDialogZIndex(_nextZ())}
        style={{ '--dialog-z': orderDialogZIndex } as React.CSSProperties}
      >
        <PlaceOrderDialog
          open={orderDialogOpen}
          onOpenChange={setOrderDialogOpen}
          symbol={orderDialogProps.symbol}
          exchange={orderDialogProps.exchange}
          action={orderDialogProps.action}
          product={orderDialogProps.product}
          quantity={orderDialogProps.quantity}
          lotSize={orderDialogProps.lotSize}
          tickSize={orderDialogProps.tickSize}
          onSuccess={() => { setOrderDialogOpen(false); fetchPositions(true) }}
        />
      </div>

      {/* ── Scalper floating panel ─────────────────────────────────────────────
           • Rendered into document.body via portal → z-index max → sits above
             ALL app chrome, sidebars, headers even when tab/route changes.
           • Draggable via pointer events on the header bar (no lib needed).
           • Initial position: bottom-center. After first drag, follows pointer.
      ─── */}
      {scalperOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={scalperElRef}
          onPointerDown={() => setScalperZIndex(_nextZ())}
          style={{
            position:  'fixed',
            zIndex:    scalperZIndex,
            bottom:    '24px',
            left:      '50%',
            transform: 'translateX(-50%)',
            width:     '460px',
            maxWidth:  'calc(100vw - 2rem)',
            touchAction: 'none',
          }}
        >
          <div className="rounded-xl border border-violet-500/30 bg-background/95 backdrop-blur-sm shadow-2xl shadow-violet-500/10 overflow-hidden">

            {/* Drag handle / header */}
            <div
              className="flex items-center justify-between px-4 py-2 bg-violet-600/10 border-b border-violet-500/20 cursor-grab active:cursor-grabbing select-none"
              onPointerDown={(e) => {
                // Only drag on left-button, ignore clicks on the close button
                if (e.button !== 0) return
                const el = scalperElRef.current
                if (!el) return
                e.currentTarget.setPointerCapture(e.pointerId)
                const rect = el.getBoundingClientRect()
                // On first drag, convert from bottom/transform to explicit left/top
                el.style.transform = 'none'
                el.style.left      = rect.left + 'px'
                el.style.top       = rect.top  + 'px'
                el.style.bottom    = 'auto'
                scalperDragRef.current = {
                  startX: e.clientX,
                  startY: e.clientY,
                  origX:  rect.left,
                  origY:  rect.top,
                }
              }}
              onPointerMove={(e) => {
                const drag = scalperDragRef.current
                const el   = scalperElRef.current
                if (!drag || !el) return
                const dx = e.clientX - drag.startX
                const dy = e.clientY - drag.startY
                const newX = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  drag.origX + dx))
                const newY = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, drag.origY + dy))
                el.style.left = newX + 'px'
                el.style.top  = newY + 'px'
              }}
              onPointerUp={() => { scalperDragRef.current = null }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Zap className="h-4 w-4 text-violet-500 shrink-0" />
                <span className="text-sm font-bold text-violet-600">Scalper</span>
                <span className="text-xs text-muted-foreground truncate">
                  {qoUnderlying} · {qoExpiry || '—'}
                </span>
                
                {underlyingLtp != null && (
                  <span className="text-xs font-mono text-muted-foreground shrink-0">
                    Spot ₹{underlyingLtp.toFixed(2)}
                  </span>
                )}

              </div>
              <Button
                variant="ghost" size="sm"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground shrink-0"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setScalperOpen(false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="px-4 py-3 space-y-2.5">

              {/* Row 1: CE/PE toggle + strike navigation + LTP */}
              <div className="flex items-center gap-2">

                {/* CE / PE toggle */}
                <div className="flex rounded-md overflow-hidden border border-border shrink-0">
                  <button
                    className={cn(
                      'px-3 py-1.5 text-xs font-bold transition-colors',
                      scalperMode === 0 ? 'bg-green-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    )}
                    onClick={() => setScalperMode(0)}
                  >CE</button>
                  <button
                    className={cn(
                      'px-3 py-1.5 text-xs font-bold transition-colors',
                      scalperMode === 1 ? 'bg-red-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    )}
                    onClick={() => setScalperMode(1)}
                  >PE</button>
                </div>

                {/* Lower strike */}
                <Button variant="outline" size="sm" className="h-7 w-7 p-0 shrink-0"
                  disabled={qoAtmIndex + scalperOffset <= 0}
                  onClick={() => setScalperOffset(o => o - 1)}
                  title="Lower strike">
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>

                {/* Strike display */}
                <div className="flex-1 flex flex-col items-center">
                  {scalperStrike != null ? (
                    <>
                      <span className="text-base font-bold font-mono leading-tight">{scalperStrike}</span>
                      <div className="flex items-center gap-1 mt-0.5">
                        {scalperOffset === 0 && (
                          <Badge variant="outline" className="text-[9px] px-1 h-4">ATM</Badge>
                        )}
                        {scalperOffset !== 0 && (() => {
                          const isOtm = scalperMode === 0 ? scalperOffset < 0 : scalperOffset > 0
                          return (
                            <Badge variant="outline" className={cn(
                              'text-[9px] px-1 h-4',
                              isOtm ? 'text-amber-500 border-amber-500/40' : 'text-muted-foreground border-border'
                            )}>
                              {isOtm ? 'OTM' : 'ITM'} {scalperOffset > 0 ? `+${scalperOffset}` : scalperOffset}
                            </Badge>
                          )
                        })()}
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">Loading…</span>
                  )}
                </div>

                {/* Higher strike */}
                <Button variant="outline" size="sm" className="h-7 w-7 p-0 shrink-0"
                  disabled={qoAtmIndex + scalperOffset >= qoStrikeList.length - 1}
                  onClick={() => setScalperOffset(o => o + 1)}
                  title="Higher strike">
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>

                {/* Live LTP */}
                <div className="shrink-0 text-right min-w-[68px]">
                  <span className={cn('text-sm font-bold font-mono', scalperMode === 0 ? 'text-green-600' : 'text-red-500')}>
                    {scalperLtp != null ? `₹${scalperLtp.toFixed(2)}` : '—'}
                  </span>
                </div>
              </div>

              {/* Row 2: Buy / Sell + lots input */}
              <div className="flex items-center gap-2">

                {/* Buy button */}
                <Button
                  size="sm"
                  className="flex-1 h-10 bg-green-600 hover:bg-green-700 active:bg-green-800 text-white font-bold text-sm disabled:opacity-50"
                  disabled={!scalperSymbol || dailyLockout || scalperIsPlacing}
                  onClick={() => handleScalperOrder('BUY')}
                >
                  {scalperIsPlacing
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <>Buy {scalperMode === 0 ? 'CE' : 'PE'}</>}
                </Button>

                {/* Sell button */}
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 h-10 border-2 border-red-500 text-red-500 hover:bg-red-500/10 active:bg-red-500/20 font-bold text-sm disabled:opacity-50"
                  disabled={!scalperSymbol || dailyLockout || scalperIsPlacing}
                  onClick={() => handleScalperOrder('SELL')}
                >
                  {scalperIsPlacing
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <>Sell {scalperMode === 0 ? 'CE' : 'PE'}</>}
                </Button>

                {/* Lots — native number input matching the PNG (dark bg, left-aligned value, native spin arrows) */}
                <div className="flex flex-col items-center gap-0.5 shrink-0">
                  <span className="text-[9px] text-muted-foreground uppercase tracking-wide leading-none">Lots</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={scalperLots}
                    onChange={(e) => {
                      const v = parseInt(e.target.value)
                      if (!isNaN(v) && v >= 1) setScalperLots(v)
                    }}
                    className={cn(
                      // Sizing
                      'h-8 w-[72px] px-2',
                      // Typography
                      'text-sm font-bold text-left',
                      // Appearance — matches the dark rounded box in the PNG
                      'rounded-md border border-input bg-background',
                      // Remove default number input styling issues on some browsers
                      'focus:outline-none focus:ring-1 focus:ring-ring',
                      // Native spin arrows styled to sit flush on the right (browser default)
                      '[appearance:auto]',
                    )}
                  />
                </div>

              </div>

              {/* Row 3: SL / Trail defaults + lot info + total value (all in one line) */}
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[10px] text-muted-foreground shrink-0">SL</span>
                <Input
                  type="number" min={0} step={1}
                  value={scalperDefaultSL}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setScalperDefaultSL(v) }}
                  className="h-6 w-14 text-xs px-1.5 text-center"
                />
                <span className="text-[10px] text-muted-foreground ml-2">Trail</span>
                <Input
                  type="number" min={0} step={1}
                  value={scalperDefaultTrail}
                  onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) setScalperDefaultTrail(v) }}
                  className="h-6 w-14 text-xs px-1.5 text-center"
                />

                {/* Lot info + total value – inline, no line break */}
                <span className="text-[10px] font-mono text-muted-foreground ml-auto whitespace-nowrap">
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

    </div>
  )
}