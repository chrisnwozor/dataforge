export interface ChartDatum {
  key: string;
  label: string;
  values: Record<string, number | null>;
}

export interface ChartSeries {
  key: string;
  label: string;
  format?: (value: number | null) => string;
}

export type ChartKind = "bar" | "line" | "area" | "donut" | "kpi";

export interface ExploreChartProps {
  kind: ChartKind;
  data: ChartDatum[];
  series: ChartSeries[];
  title: string;
  horizontal?: boolean;
  stacked?: boolean;
  showLegend?: boolean;
  colors?: string[];
  onMemberClick?: (datum: ChartDatum) => void;
}
