"use client";

import { ExploreChart } from "./explore-chart";
import type { ExploreChartProps } from "./types";

type Props = Omit<ExploreChartProps, "kind">;
export function BarChart(props: Props) { return <ExploreChart {...props} kind="bar" />; }
export function LineChart(props: Props) { return <ExploreChart {...props} kind="line" />; }
export function AreaChart(props: Props) { return <ExploreChart {...props} kind="area" />; }
export function DonutChart(props: Props) { return <ExploreChart {...props} kind="donut" />; }
export function KpiCards(props: Props) { return <ExploreChart {...props} kind="kpi" />; }
