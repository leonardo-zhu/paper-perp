import type { Candle } from '@paperperp/shared';
import { useQuery } from '@tanstack/react-query';
import {
  CandlestickSeries,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { marketFeed, useMarket } from '../stores/market';

const UP = '#22c993';
const DOWN = '#f2545b';

const toBar = (c: Candle) => ({
  time: (c.t / 1000) as UTCTimestamp,
  open: c.o,
  high: c.h,
  low: c.l,
  close: c.c,
});
const toVol = (c: Candle) => ({
  time: (c.t / 1000) as UTCTimestamp,
  value: c.v,
  color: c.c >= c.o ? 'rgba(34,201,147,0.35)' : 'rgba(242,84,91,0.35)',
});

export function PriceChart() {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastTime = useRef(0);

  const history = useQuery({
    queryKey: ['klines', marketFeed.symbol],
    queryFn: () => api<{ candles: Candle[] }>(`/api/markets/${marketFeed.symbol}/klines`),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#8b93a7', fontFamily: 'inherit' },
      grid: { vertLines: { color: '#1c2029' }, horzLines: { color: '#1c2029' } },
      rightPriceScale: { borderColor: '#262b36' },
      timeScale: { borderColor: '#262b36', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    volume.current = c.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
    });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const data = history.data?.candles;
    if (!data?.length || !candles.current || !volume.current) return;
    candles.current.setData(data.map(toBar));
    volume.current.setData(data.map(toVol));
    lastTime.current = data.at(-1)!.t;
    chart.current?.timeScale().scrollToRealTime();
  }, [history.data]);

  // Live candle updates bypass React state: subscribe to the store directly.
  useEffect(
    () =>
      useMarket.subscribe((s, prev) => {
        const c = s.candle;
        if (!c || c === prev.candle || !candles.current || !volume.current) return;
        if (c.t < lastTime.current) return; // older than what the chart has
        lastTime.current = c.t;
        candles.current.update(toBar(c));
        volume.current.update(toVol(c));
      }),
    [],
  );

  return (
    <section className="panel chart" aria-label="Price chart">
      <header className="panel-head">
        <h2>BTC-PERP · 1m</h2>
        {history.isError && <span className="muted small">history unavailable</span>}
      </header>
      <div ref={el} className="chart-canvas" />
    </section>
  );
}
