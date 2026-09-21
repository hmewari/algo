import { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAuthStore } from '@/stores/authStore'
import { Switch } from '@/components/ui/switch'
import { useLiveQuote } from '@/hooks/useLiveQuote'
import { tradingApi } from '@/api/trading'
import { showToast } from '@/utils/toast'
import { cn } from '@/lib/utils'
import { QuoteHeader } from './QuoteHeader'
import { MarketDepthPanel } from './MarketDepthPanel'

// ─────────────────────────────────────────────────────────────────────────────
// USER CUSTOMIZATIONS PRESERVED:
//   1. Trailing SL is ON by default.
//   2. SL / Target are OFF by default.
//   3. Protection is saved to POST /api/protection/save and also announced via
//      the protection-created CustomEvent.
//   4. SL / TGT / Trail inputs stay in a fixed 3-column layout.
//   5. Quantity is remembered per symbol/exchange for the current page session.
// ─────────────────────────────────────────────────────────────────────────────

const PRICE_TYPES = [
  { value: 'MARKET', label: 'Market' },
  { value: 'LIMIT',  label: 'Limit'  },
  { value: 'SL-M',   label: 'SL-M'   },
  { value: 'SL',     label: 'SL-L'   },
] as const

const FNO_PRODUCT_TYPES    = [{ value: 'NRML', label: 'NRML' }, { value: 'MIS', label: 'MIS' }] as const
const EQUITY_PRODUCT_TYPES = [{ value: 'CNC',  label: 'CNC'  }, { value: 'MIS', label: 'MIS' }] as const

// ── Protection default percentages ──────────────────────────────────────────
const SL_PCT    = 0.05   // 5%  — SL distance from LTP
const TGT_PCT   = 0.15   // 15% — Target distance from LTP
const TRAIL_PCT = 0.05   // 5%  — Trailing distance as % of LTP
// ────────────────────────────────────────────────────────────────────────────

function roundToTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price
  return Number((Math.round(price / tickSize) * tickSize).toFixed(2))
}

function adjustPrice(price: number, tickSize: number, dir: 'up' | 'down'): number {
  const r = roundToTick(price, tickSize)
  return dir === 'up'
    ? Number((r + tickSize).toFixed(2))
    : Math.max(0, Number((r - tickSize).toFixed(2)))
}

function isFnOExchange(exchange: string): boolean {
  return ['NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCDEX', 'NCO', 'CRYPTO'].includes(exchange)
}

// ── Per-symbol quantity memory (survives dialog close within same page session) ─
// Key: `${symbol}_${exchange}`  Value: lotMultiplier last used for that symbol
const _qtyMemory = new Map<string, number>()

function getRememberedLots(symbol: string, exchange: string, fallback: number): number {
  return _qtyMemory.get(`${symbol}_${exchange}`) ?? fallback
}

function rememberLots(symbol: string, exchange: string, lots: number): void {
  if (lots > 0) _qtyMemory.set(`${symbol}_${exchange}`, lots)
}


export interface TicketOrder {
  symbol: string
  exchange: string
  action: 'BUY' | 'SELL'
  quantity: number
  pricetype: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
  product: 'MIS' | 'NRML' | 'CNC'
  price?: number
  trigger_price?: number
}

export function lotsFor(quantity: number | undefined, lotSize: number): number {
  if (quantity === undefined || lotSize <= 0) return 1
  return Math.max(1, Math.round(quantity / lotSize))
}

export interface PlaceOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  symbol?: string
  exchange?: string
  action?: 'BUY' | 'SELL'
  quantity?: number
  lotSize?: number
  tickSize?: number
  product?: 'MIS' | 'NRML' | 'CNC'
  priceType?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M'
  price?: number
  triggerPrice?: number
  strategy?: string
  place?: (order: TicketOrder) => Promise<{ orderId: string }>
  container?: HTMLElement | null
  onSuccess?: (orderId: string) => void
  onError?: (error: string) => void
  /** Z-index for the dialog overlay — used for bring-to-front management */
  zIndex?: number
}

export function PlaceOrderDialog({
  open,
  onOpenChange,
  symbol = '',
  exchange = '',
  action: initialAction = 'BUY',
  quantity: initialQuantity,
  lotSize = 1,
  tickSize = 0.05,
  product: initialProduct = 'NRML',
  priceType: initialPriceType = 'MARKET',
  price: initialPrice,
  triggerPrice: initialTriggerPrice,
  strategy = 'OptionChain',
  place,
  container,
  onSuccess,
  onError,
  zIndex = 1000,
}: PlaceOrderDialogProps) {
  const { apiKey } = useAuthStore()

  // ── Form state ────────────────────────────────────────────────────────────
  const [availableBalance,  setAvailableBalance]  = useState(0)
  const [formAction,        setFormAction]        = useState<'BUY' | 'SELL'>(initialAction)
  const [formQuantity,      setFormQuantity]      = useState(() => {
    const remembered = getRememberedLots(symbol, exchange, 0)
    if (remembered > 0 && lotSize > 0) return remembered * lotSize
    return initialQuantity ?? lotSize
  })
  const [formPriceType,     setFormPriceType]     = useState(initialPriceType)
  const [formProduct,       setFormProduct]       = useState(initialProduct)
  const [formPrice,         setFormPrice]         = useState(0)
  const [formTriggerPrice,  setFormTriggerPrice]  = useState(0)
  const [isSubmitting,      setIsSubmitting]      = useState(false)
  const [isDepthExpanded,   setIsDepthExpanded]   = useState(false)
  const [quantityMode,      setQuantityMode]      = useState<'lots' | 'shares'>('lots')
  // Seed from session memory — if user placed a NIFTY CE order with 2 lots before,
  // next time they open any NIFTY CE dialog it starts with 2 lots.
  const [lotMultiplier,     setLotMultiplier]     = useState(() => {
    const remembered = getRememberedLots(symbol, exchange, 0)
    if (remembered > 0) return remembered
    return initialQuantity && lotSize > 0 ? Math.round(initialQuantity / lotSize) : 1
  })

  // Current upstream: cash equity can switch between NSE and BSE.
  const [formExchange, setFormExchange] = useState(exchange)
  const exchange_ = formExchange || exchange
  const isEquityExchange = exchange_ === 'NSE' || exchange_ === 'BSE'
  const usesLots = isFnOExchange(exchange_) && lotSize > 1

  // ── Protection state — NEW DEFAULTS ──────────────────────────────────────
  // Trailing SL: ON by default  (user wants trailing protection immediately)
  // SL / Target: OFF by default (user can enable if they want a hard price)
  const [slEnabled,       setSlEnabled]       = useState(false)   // ← CHANGED: was true
  const [slPrice,         setSlPrice]         = useState(0)
  const [targetPrice,     setTargetPrice]     = useState(0)
  const [trailingEnabled, setTrailingEnabled] = useState(true)    // ← CHANGED: was false
  const [trailingPoints,  setTrailingPoints]  = useState(0)
  const [slAutoMode,      setSlAutoMode]      = useState(true)

  const productTypes = isFnOExchange(exchange_) ? FNO_PRODUCT_TYPES : EQUITY_PRODUCT_TYPES

  // ── Live quote ────────────────────────────────────────────────────────────
  const { data: liveData, isLoading: isLoadingQuotes, isConnected } = useLiveQuote(symbol, exchange_, {
    enabled: open && !!symbol && !!exchange_,
    mode: 'Depth',
    useQuotesFallback: true,
    useDepthFallback: true,
  })

  const mergedData = {
    ltp:           liveData.ltp,
    close:         liveData.close,
    change:        liveData.change,
    change_percent: liveData.changePercent,
    bidPrice:      liveData.bidPrice,
    askPrice:      liveData.askPrice,
    bidSize:       liveData.bidSize,
    askSize:       liveData.askSize,
    depth:         liveData.depth,
  }

  // ── Fetch balance ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    fetch('/auth/dashboard-data', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.status === 'success' && data.data) {
          setAvailableBalance(parseFloat(data.data.availablecash || '0'))
        }
      })
      .catch(() => {})
  }, [open])

  // ── Reset form on open ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return

    setFormAction(initialAction)
    setFormPriceType(initialPriceType)

    const isFnO = isFnOExchange(exchange)
    const defaultProd = isFnO ? 'NRML' : 'CNC'
    const validProds = isFnO ? ['NRML', 'MIS'] : ['CNC', 'MIS']

    setFormProduct(
      initialProduct && validProds.includes(initialProduct)
        ? initialProduct
        : defaultProd
    )

    setFormPrice(initialPrice ?? 0)
    setFormTriggerPrice(initialTriggerPrice ?? 0)
    setIsDepthExpanded(false)

    const remembered = getRememberedLots(symbol, exchange, 0)
    const seedLots = remembered > 0
      ? remembered
      : (initialQuantity && lotSize > 0 ? Math.max(1, Math.round(initialQuantity / lotSize)) : 1)

    setLotMultiplier(seedLots)

    if (isFnO && lotSize > 1) {
      setQuantityMode('lots')
      setFormQuantity(seedLots * lotSize)
    } else {
      setQuantityMode('shares')
      setFormQuantity(initialQuantity ?? lotSize)
    }

    // Preserve existing protection defaults.
    setSlEnabled(false)
    setSlPrice(0)
    setTargetPrice(0)
    setTrailingEnabled(true)
    setTrailingPoints(0)
    setSlAutoMode(true)

    setFormExchange(exchange)
  }, [
    open,
    initialAction,
    initialQuantity,
    lotSize,
    initialPriceType,
    initialProduct,
    initialPrice,
    initialTriggerPrice,
    exchange,
    symbol,
  ])

  // ── Auto SL / Target when slEnabled & slAutoMode ─────────────────────────
  useEffect(() => {
    if (!open || !slEnabled || !mergedData.ltp || !slAutoMode) return
    const ltp   = mergedData.ltp
    const isBuy = formAction === 'BUY'
    setSlPrice(isBuy ? Math.round(ltp * (1 - SL_PCT)) : Math.round(ltp * (1 + SL_PCT)))
    setTargetPrice(isBuy ? Math.round(ltp * (1 + TGT_PCT)) : Math.round(ltp * (1 - TGT_PCT)))
  }, [mergedData.ltp, formAction, slEnabled, open, slAutoMode])

  // ── Auto trailing points from SL distance (when both enabled) ────────────
  useEffect(() => {
    if (!open || !slEnabled || !trailingEnabled || !mergedData.ltp || slPrice <= 0) return
    const ltp      = mergedData.ltp
    const distance = formAction === 'BUY' ? ltp - slPrice : slPrice - ltp
    if (distance <= 0) return
    setTrailingPoints(Math.max(1, Math.round(distance / 5)))
  }, [slPrice, mergedData.ltp, formAction, trailingEnabled, slEnabled, open])

  // ── Auto trailing points when trailing-only (SL off) ────────────────────
  useEffect(() => {
    if (!open || !trailingEnabled || slEnabled) return
    if (!mergedData.ltp || mergedData.ltp <= 0 || trailingPoints > 0) return
    setTrailingPoints(Math.max(1, Math.round(mergedData.ltp * TRAIL_PCT)))
  }, [trailingEnabled, slEnabled, mergedData.ltp, open])

  // ── NEW: Auto-set trailing points as soon as LTP arrives (trailing-only mode) ─
  // This fills the box even before the user touches anything so it's never blank.
  useEffect(() => {
    if (!open || !trailingEnabled || slEnabled || !mergedData.ltp) return
    if (trailingPoints > 0) return   // already set
    setTrailingPoints(Math.max(1, Math.round(mergedData.ltp * TRAIL_PCT)))
  }, [open, trailingEnabled, slEnabled, mergedData.ltp])

  // ── Price mode ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (formPriceType !== 'MARKET' && mergedData.ltp && formPrice === 0) {
      setFormPrice(roundToTick(mergedData.ltp, tickSize))
    }
  }, [formPriceType, mergedData.ltp, formPrice, tickSize])

  const needsPrice   = formPriceType === 'LIMIT' || formPriceType === 'SL'
  const needsTrigger = formPriceType === 'SL-M'  || formPriceType === 'SL'

  // ── Validation ────────────────────────────────────────────────────────────
  const isValid = useCallback(() => {
    if (!symbol || !exchange_ || !apiKey || formQuantity <= 0) return false
    if (needsPrice && formPrice <= 0) return false
    if (needsTrigger && formTriggerPrice <= 0) return false
    if (slEnabled && slPrice <= 0) return false
    if (trailingEnabled && trailingPoints <= 0 && !mergedData.ltp) return false
    return true
  }, [
    symbol,
    exchange_,
    apiKey,
    formQuantity,
    needsPrice,
    formPrice,
    needsTrigger,
    formTriggerPrice,
    slEnabled,
    slPrice,
    trailingEnabled,
    trailingPoints,
    mergedData.ltp,
  ])

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!isValid()) {
      showToast.error('Please fill all required fields')
      return
    }

    if (!apiKey) {
      showToast.error('API key not found')
      onError?.('API key not found')
      return
    }

    setIsSubmitting(true)

    try {
      let computedSlPrice = slEnabled ? slPrice : 0
      const computedTargetPrice = slEnabled ? targetPrice : 0
      let submitSlEnabled = slEnabled

      let resolvedTrailPoints = trailingEnabled ? trailingPoints : 0
      if (trailingEnabled && resolvedTrailPoints <= 0 && mergedData.ltp) {
        resolvedTrailPoints = Math.max(1, Math.round(mergedData.ltp * TRAIL_PCT))
      }
      const submitTrailPoints = resolvedTrailPoints

      // Trail-only protection uses an implicit initial SL.
      if (submitTrailPoints > 0 && !submitSlEnabled && mergedData.ltp) {
        computedSlPrice = Math.max(
          0,
          roundToTick(
            formAction === 'BUY'
              ? mergedData.ltp - submitTrailPoints
              : mergedData.ltp + submitTrailPoints,
            tickSize
          )
        )
        submitSlEnabled = true
      }

      const order: TicketOrder = {
        exchange: exchange_,
        symbol,
        action: formAction,
        quantity: formQuantity,
        pricetype: formPriceType as 'MARKET' | 'LIMIT' | 'SL' | 'SL-M',
        product: formProduct,
        ...(needsPrice && { price: formPrice }),
        ...(needsTrigger && { trigger_price: formTriggerPrice }),
      }

      let orderId = ''

      if (place) {
        const placed = await place(order)
        orderId = placed.orderId
      } else {
        const response = await tradingApi.placeOrder({
          apikey: apiKey,
          strategy,
          ...order,
        })

        orderId = (response as unknown as { orderid?: string }).orderid || ''

        if (response.status !== 'success' || !orderId) {
          const msg = response.message || 'Order placement failed'
          showToast.error(msg, 'orders')
          onError?.(msg)
          return
        }
      }

      onSuccess?.(orderId)

      // Save protection to the server DB after the order succeeds.
      const protectionPayload: Record<string, unknown> = { status: 'ACTIVE' }

      if (submitSlEnabled && computedSlPrice > 0) {
        protectionPayload.sl_price = computedSlPrice
        protectionPayload.current_sl = computedSlPrice
      }

      if (submitSlEnabled && computedTargetPrice > 0) {
        protectionPayload.target_price = computedTargetPrice
      }

      if (submitTrailPoints > 0) {
        protectionPayload.trailing_points = submitTrailPoints
      }

      const hasProtection =
        protectionPayload.sl_price !== undefined ||
        protectionPayload.target_price !== undefined ||
        protectionPayload.trailing_points !== undefined

      if (hasProtection) {
        const posKey = `${symbol}_${exchange_}_${formProduct}`

        try {
          await fetch('/api/protection/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              key: posKey,
              protection: protectionPayload,
            }),
          })
        } catch (err) {
          console.error('PlaceOrderDialog: protection save to server failed', err)
        }

        // Positions.tsx uses this event to display the saved protection immediately.
        window.dispatchEvent(
          new CustomEvent('protection-created', {
            detail: {
              symbol,
              exchange: exchange_,
              product: formProduct,
              sl_price: submitSlEnabled && computedSlPrice > 0 ? computedSlPrice : null,
              target_price:
                submitSlEnabled && computedTargetPrice > 0
                  ? computedTargetPrice
                  : null,
              trailing_points: submitTrailPoints > 0 ? submitTrailPoints : null,
            },
          })
        )
      }

      window.dispatchEvent(new Event('positions-updated'))
      onOpenChange(false)
    } catch (err: unknown) {
      let msg = 'Order placement failed'

      if (err && typeof err === 'object') {
        const e = err as {
          response?: { data?: { message?: string } }
          message?: string
        }
        msg = e.response?.data?.message || e.message || msg
      }

      showToast.error(msg, 'orders')
      onError?.(msg)
    } finally {
      setIsSubmitting(false)
    }
  }

  // ── Quantity helpers ──────────────────────────────────────────────────────
  const handleQuantityChange = (value: string) => {
    const num = parseInt(value) || 0
    if (quantityMode === 'lots') {
      setFormQuantity(num * lotSize)
      setLotMultiplier(num)
      rememberLots(symbol, exchange, num)          // ← persist for next open
    } else {
      const rounded  = Math.max(lotSize, Math.round(num / lotSize) * lotSize)
      const lots     = rounded / lotSize
      setFormQuantity(rounded)
      setLotMultiplier(lots)
      rememberLots(symbol, exchange, lots)         // ← persist for next open
    }
  }

  const effectivePrice  = formPriceType === 'MARKET' ? mergedData.ltp || 0 : formPrice || mergedData.ltp || 0
  const tradeValue      = effectivePrice * formQuantity
  const remainingBalance = availableBalance - tradeValue
  const displayQuantity  = quantityMode === 'lots' ? lotMultiplier : formQuantity
  const isLoading        = isLoadingQuotes && !mergedData.ltp && !isConnected
  const insufficientFunds = formAction === 'BUY' && remainingBalance < 0

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-full sm:max-w-[460px]"
        aria-describedby={undefined}
        container={container}
        style={{ zIndex: zIndex + 1 }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Place Order -</span>
            <span className={formAction === 'BUY' ? 'text-green-500' : 'text-red-500'}>{formAction}</span>
            <span className="text-muted-foreground font-normal text-sm truncate">{symbol}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <QuoteHeader
            exchange={exchange_}
            ltp={mergedData.ltp}
            prevClose={mergedData.close}
            change={mergedData.change}
            changePercent={mergedData.change_percent}
            bidPrice={mergedData.bidPrice}
            askPrice={mergedData.askPrice}
            bidSize={mergedData.bidSize}
            askSize={mergedData.askSize}
            isLoading={isLoading}
          />

          <MarketDepthPanel
            depth={mergedData.depth}
            isExpanded={isDepthExpanded}
            onToggle={() => setIsDepthExpanded(!isDepthExpanded)}
            maxLevels={5}
          />

          {/* BUY / SELL toggle */}
          <div className="space-y-2">
            <Label className="text-xs">Action</Label>
            <div className="flex gap-2">
            <Button type="button" variant={formAction === 'BUY' ? 'default' : 'outline'}
              className={cn('flex-1', formAction === 'BUY' && 'bg-green-600 hover:bg-green-700')}
              onClick={() => setFormAction('BUY')}>BUY</Button>
              <Button type="button" variant={formAction === 'SELL' ? 'default' : 'outline'}
                className={cn('flex-1', formAction === 'SELL' && 'bg-red-600 hover:bg-red-700')}
                onClick={() => setFormAction('SELL')}>SELL</Button>
            </div>
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Quantity</Label>
              {usesLots && (
                <div className="flex gap-1">
                  {(['lots', 'shares'] as const).map(mode => (
                    <button key={mode} type="button" onClick={() => setQuantityMode(mode)}
                      className={cn('px-2 py-0.5 text-[10px] rounded',
                        quantityMode === mode ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      )}>
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Input type="number" value={displayQuantity} onChange={(e) => handleQuantityChange(e.target.value)} min={1} />
            <div className="text-[10px] text-muted-foreground flex items-center">
              <div className="flex-1">Lot {lotMultiplier}</div>
              <div className="flex-1">Qty {formQuantity}</div>
              <div className="flex-1">Val ₹{tradeValue.toLocaleString()}</div>
              <div className={cn('flex-1 text-right', remainingBalance < 0 ? 'text-red-500' : 'text-green-500')}>
                Rem ₹{remainingBalance.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Exchange selector for cash equity. */}
          {isEquityExchange && (
            <div className="space-y-2">
              <Label className="text-xs">Exchange</Label>
              <Select value={exchange_} onValueChange={setFormExchange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NSE">NSE</SelectItem>
                  <SelectItem value="BSE">BSE</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Price Type + Product */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-xs">Price Type</Label>
              <Select value={formPriceType} onValueChange={(v) => setFormPriceType(v as typeof formPriceType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRICE_TYPES.map(pt => <SelectItem key={pt.value} value={pt.value}>{pt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Product</Label>
              <Select value={formProduct} onValueChange={(v) => setFormProduct(v as typeof formProduct)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {productTypes.map(pt => <SelectItem key={pt.value} value={pt.value}>{pt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Limit price (conditional) */}
          {needsPrice && (
            <div className="space-y-2">
              <Label className="text-xs">Price</Label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" className="px-2"
                  onClick={() => setFormPrice(adjustPrice(formPrice, tickSize, 'down'))}>-</Button>
                <Input type="number" value={formPrice}
                  onChange={(e) => setFormPrice(parseFloat(e.target.value) || 0)}
                  onBlur={() => setFormPrice(roundToTick(formPrice, tickSize))}
                  className="flex-1 text-center" step={tickSize} min={0} />
                <Button type="button" variant="outline" size="sm" className="px-2"
                  onClick={() => setFormPrice(adjustPrice(formPrice, tickSize, 'up'))}>+</Button>
              </div>
              <p className="text-[10px] text-muted-foreground">Tick size: {tickSize}</p>
            </div>
          )}

          {/* Trigger price (conditional) */}
          {needsTrigger && (
            <div className="space-y-2">
              <Label className="text-xs">Trigger Price</Label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" className="px-2"
                  onClick={() => setFormTriggerPrice(adjustPrice(formTriggerPrice, tickSize, 'down'))}>-</Button>
                <Input type="number" value={formTriggerPrice}
                  onChange={(e) => setFormTriggerPrice(parseFloat(e.target.value) || 0)}
                  onBlur={() => setFormTriggerPrice(roundToTick(formTriggerPrice, tickSize))}
                  className="flex-1 text-center" step={tickSize} min={0} />
                <Button type="button" variant="outline" size="sm" className="px-2"
                  onClick={() => setFormTriggerPrice(adjustPrice(formTriggerPrice, tickSize, 'up'))}>+</Button>
              </div>
            </div>
          )}

          {/* ── SL / Target / Trailing ─────────────────────────────────────────
              LAYOUT RULES:
              • The toggle row is always shown.
              • The inputs row is ALWAYS rendered as a fixed 3-column grid.
              • Each column takes exactly 1/3 of the width — no flex shrinking.
              • Disabled columns show a dimmed, non-interactive placeholder input
                so the layout never shifts when toggles change.
          ──────────────────────────────────────────────────────────────────── */}
          <div className="space-y-2">

            {/* Toggle row */}
            <div className="flex items-center justify-between">
              {/* Left: SL / Target toggle */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">SL / Target</span>
                <Switch
                  checked={slEnabled}
                  onCheckedChange={(checked) => {
                    setSlEnabled(checked)
                    if (checked && mergedData.ltp) {
                      const ltp   = mergedData.ltp
                      const isBuy = formAction === 'BUY'
                      setSlPrice(isBuy ? Math.round(ltp * (1 - SL_PCT)) : Math.round(ltp * (1 + SL_PCT)))
                      setTargetPrice(isBuy ? Math.round(ltp * (1 + TGT_PCT)) : Math.round(ltp * (1 - TGT_PCT)))
                      setSlAutoMode(true)
                    } else if (!checked) {
                      setSlPrice(0); setTargetPrice(0)
                      // Do NOT disable trailing when SL is turned off
                    }
                  }}
                />
              </div>

              {/* Right: Trailing SL toggle */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">Trailing SL</span>
                <Switch
                  checked={trailingEnabled}
                  onCheckedChange={(checked) => {
                    setTrailingEnabled(checked)
                    if (checked) {
                      if (slEnabled && mergedData.ltp && slPrice > 0) {
                        const dist = formAction === 'BUY' ? mergedData.ltp - slPrice : slPrice - mergedData.ltp
                        setTrailingPoints(Math.max(1, Math.round(dist / 5)))
                      } else if (mergedData.ltp) {
                        setTrailingPoints(Math.max(1, Math.round(mergedData.ltp * TRAIL_PCT)))
                      }
                    } else {
                      setTrailingPoints(0)
                    }
                  }}
                />
              </div>
            </div>

            {/* ── Fixed 3-column input grid ────────────────────────────────────
                Always rendered. Disabled columns are visually muted.
                grid-cols-3 with no gap-between keeps a seamless look.
            ────────────────────────────────────────────────────────────────── */}
            <div className="grid grid-cols-3 gap-2">

              {/* Column 1: SL */}
              <div className="space-y-1">
                <span className={cn(
                  'text-[11px] font-semibold flex items-center gap-1',
                  slEnabled ? 'text-red-400' : 'text-muted-foreground/50'
                )}>
                  <span className={cn('w-2 h-2 rounded-full', slEnabled ? 'bg-red-500' : 'bg-muted-foreground/30')} />
                  SL
                </span>
                <Input
                  type="number"
                  value={slEnabled && slPrice > 0 ? slPrice : ''}
                  placeholder={slEnabled ? '0' : '—'}
                  disabled={!slEnabled}
                  onChange={(e) => {
                    setSlAutoMode(false)
                    setSlPrice(parseFloat(e.target.value) || 0)
                  }}
                  className={cn(
                    'h-8 text-center text-sm',
                    !slEnabled && 'opacity-30 cursor-not-allowed bg-muted'
                  )}
                />
              </div>

              {/* Column 2: Target */}
              <div className="space-y-1">
                <span className={cn(
                  'text-[11px] font-semibold flex items-center gap-1',
                  slEnabled ? 'text-green-400' : 'text-muted-foreground/50'
                )}>
                  <span className={cn('w-2 h-2 rounded-full', slEnabled ? 'bg-green-500' : 'bg-muted-foreground/30')} />
                  TGT
                </span>
                <Input
                  type="number"
                  value={slEnabled && targetPrice > 0 ? targetPrice : ''}
                  placeholder={slEnabled ? '0' : '—'}
                  disabled={!slEnabled}
                  onChange={(e) => {
                    setSlAutoMode(false)
                    setTargetPrice(parseFloat(e.target.value) || 0)
                  }}
                  className={cn(
                    'h-8 text-center text-sm',
                    !slEnabled && 'opacity-30 cursor-not-allowed bg-muted'
                  )}
                />
              </div>

              {/* Column 3: Trail — always active when trailingEnabled, stays in place when not */}
              <div className="space-y-1">
                <span className={cn(
                  'text-[11px] font-semibold flex items-center gap-1',
                  trailingEnabled ? 'text-blue-400' : 'text-muted-foreground/50'
                )}>
                  <span className={cn('w-2 h-2 rounded-full', trailingEnabled ? 'bg-blue-500' : 'bg-muted-foreground/30')} />
                  Trail
                </span>
                <Input
                  type="number"
                  min={1}
                  value={trailingEnabled && trailingPoints > 0 ? trailingPoints : ''}
                  placeholder={trailingEnabled ? '0' : '—'}
                  disabled={!trailingEnabled}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || 1
                    setTrailingPoints(val)
                    // If SL is off, derive it from trail distance
                    if (!slEnabled && mergedData.ltp) {
                      setSlPrice(Math.max(0, roundToTick(
                        formAction === 'BUY' ? mergedData.ltp - 1.2 * val : mergedData.ltp + 1.2 * val,
                        tickSize
                      )))
                    }
                  }}
                  className={cn(
                    'h-8 text-center text-sm',
                    !trailingEnabled && 'opacity-30 cursor-not-allowed bg-muted'
                  )}
                />
              </div>

            </div>
            {/* Helpful hint line */}
            {(slEnabled || trailingEnabled) && (
              <p className="text-[10px] text-muted-foreground leading-tight">
                {trailingEnabled && !slEnabled}
                {slEnabled && trailingEnabled}
                {slEnabled && !trailingEnabled}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid() || isSubmitting || insufficientFunds}
            className={cn(formAction === 'BUY' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700')}
          >
            {isSubmitting ? 'Placing...' : `Place ${formAction} Order`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PlaceOrderDialog