import { Box, Typography, useTheme } from '@mui/material';
import SmoothieComponent, { TimeSeries } from 'react-smoothie';
import { StationName, StatusEntry, StationNameList } from '../../../src/types';
import { useUpdateCallback } from '../hooks/useBackend';

export type MetricType = 'signalLevels' | 'snr' | 'rates' | 'packets' | 'bytes' | 'bandwidth' | 'quality' | 'dataAge';

interface StationChartProps {
  station: StationName;
  metric: MetricType;
  height?: string;
}

// Create TimeSeries instances at module level so they persist across component mounts/unmounts
const stationTimeSeries: Record<
  StationName,
  {
    dataAgeMs: TimeSeries;
    signalDbm: TimeSeries;
    noiseDbm: TimeSeries;
    signalNoiseRatio: TimeSeries;
    rxRateMbps: TimeSeries;
    rxPackets: TimeSeries;
    rxBytes: TimeSeries;
    txRateMbps: TimeSeries;
    txPackets: TimeSeries;
    txBytes: TimeSeries;
    bandwidthUsedMbps: TimeSeries;
    qualityExcellent: TimeSeries;
    qualityGood: TimeSeries;
    qualityCaution: TimeSeries;
    qualityWarning: TimeSeries;
    qualityNone: TimeSeries;
  }
> = {} as any;

// Initialize TimeSeries for each station
for (const stationName of StationNameList) {
  stationTimeSeries[stationName] = {
    dataAgeMs: new TimeSeries(),
    signalDbm: new TimeSeries(),
    noiseDbm: new TimeSeries(),
    signalNoiseRatio: new TimeSeries(),
    rxRateMbps: new TimeSeries(),
    rxPackets: new TimeSeries(),
    rxBytes: new TimeSeries(),
    txRateMbps: new TimeSeries(),
    txPackets: new TimeSeries(),
    txBytes: new TimeSeries(),
    bandwidthUsedMbps: new TimeSeries(),
    qualityExcellent: new TimeSeries(),
    qualityGood: new TimeSeries(),
    qualityCaution: new TimeSeries(),
    qualityWarning: new TimeSeries(),
    qualityNone: new TimeSeries(),
  };
}

// Track the last processed timestamp to avoid duplicate data when multiple charts are mounted
let lastProcessedTimestamp = 0;

// Track the current SSID for each station to detect reconfiguration
const stationSSIDs: Record<StationName, string> = {} as any;
for (const stationName of StationNameList) {
  stationSSIDs[stationName] = '';
}

// Helper function to clear all timeseries for a station
function clearStationTimeSeries(stationName: StationName) {
  const series = stationTimeSeries[stationName];
  series.dataAgeMs.clear();
  series.signalDbm.clear();
  series.noiseDbm.clear();
  series.signalNoiseRatio.clear();
  series.rxRateMbps.clear();
  series.rxPackets.clear();
  series.rxBytes.clear();
  series.txRateMbps.clear();
  series.txPackets.clear();
  series.txBytes.clear();
  series.bandwidthUsedMbps.clear();
  series.qualityExcellent.clear();
  series.qualityGood.clear();
  series.qualityCaution.clear();
  series.qualityWarning.clear();
  series.qualityNone.clear();
}

// Set up a single listener at module level that populates all station time series
function handleStatusUpdate(entry: StatusEntry) {
  // Skip if we've already processed this timestamp (multiple charts calling the same handler)
  if (entry.timestamp === lastProcessedTimestamp) return;
  lastProcessedTimestamp = entry.timestamp;

  if (!entry.radioUpdate) return;

  for (const stationName of StationNameList) {
    const stationStatus = entry.radioUpdate.stationStatuses[stationName];

    // Detect SSID change (reconfiguration) and clear timeseries
    const currentSSID = stationStatus?.ssid || '';
    if (currentSSID !== stationSSIDs[stationName]) {
      if (stationSSIDs[stationName] !== '') {
        // Only clear if we had a previous SSID (not initial load)
        clearStationTimeSeries(stationName);
      }
      stationSSIDs[stationName] = currentSSID;
    }

    if (!stationStatus || !stationStatus.isLinked) {
      continue;
    }

    const timestamp = entry.timestamp;
    const timeSeries = stationTimeSeries[stationName];
    const {
      dataAgeMs,
      signalDbm,
      noiseDbm,
      signalNoiseRatio,
      rxRateMbps,
      rxPackets,
      rxBytes,
      txRateMbps,
      txPackets,
      txBytes,
      bandwidthUsedMbps,
      connectionQuality,
    } = stationStatus;

    if (dataAgeMs !== undefined) timeSeries.dataAgeMs.append(timestamp, dataAgeMs);
    if (signalDbm !== undefined) timeSeries.signalDbm.append(timestamp, signalDbm);
    if (noiseDbm !== undefined) timeSeries.noiseDbm.append(timestamp, noiseDbm);
    if (signalNoiseRatio !== undefined) timeSeries.signalNoiseRatio.append(timestamp, signalNoiseRatio);
    if (rxRateMbps !== undefined) timeSeries.rxRateMbps.append(timestamp, rxRateMbps);
    if (rxPackets !== undefined) timeSeries.rxPackets.append(timestamp, rxPackets);
    if (rxBytes !== undefined) timeSeries.rxBytes.append(timestamp, rxBytes);
    if (txRateMbps !== undefined) timeSeries.txRateMbps.append(timestamp, txRateMbps);
    if (txPackets !== undefined) timeSeries.txPackets.append(timestamp, txPackets);
    if (txBytes !== undefined) timeSeries.txBytes.append(timestamp, txBytes);
    if (bandwidthUsedMbps !== undefined) timeSeries.bandwidthUsedMbps.append(timestamp, bandwidthUsedMbps);

    // Convert connectionQuality string to binary indicators for each quality level
    timeSeries.qualityExcellent.append(timestamp, connectionQuality === 'excellent' ? 1 : 0);
    timeSeries.qualityGood.append(timestamp, connectionQuality === 'good' ? 1 : 0);
    timeSeries.qualityCaution.append(timestamp, connectionQuality === 'caution' ? 1 : 0);
    timeSeries.qualityWarning.append(timestamp, connectionQuality === 'warning' ? 1 : 0);
    timeSeries.qualityNone.append(timestamp, connectionQuality === '' ? 1 : 0);
  }
}

type ChartConfig = {
  title: string;
  unit?: string;
  minValue?: number;
  maxValue?: number;
  hideLabels?: boolean;
  series: Array<{
    data: keyof (typeof stationTimeSeries)[StationName];
    label: string;
    fillStyle?: string;
    color: { r: number; g: number; b: number };
    lineWidth: number;
  }>;
};

const metricConfigs: Record<MetricType, ChartConfig> = {
  signalLevels: {
    title: 'Signal Levels',
    unit: 'dBm',
    minValue: -105,
    maxValue: -45,
    series: [
      { data: 'signalDbm', label: 'Signal', color: { r: 80, g: 200, b: 100 }, lineWidth: 2 },
      {
        data: 'noiseDbm',
        label: 'Noise',
        color: { r: 255, g: 150, b: 150 },
        fillStyle: 'rgba(255, 150, 150, 0.7)',
        lineWidth: 0,
      },
    ],
  },
  snr: {
    title: 'Signal-to-Noise Ratio',
    unit: 'dB',
    series: [{ data: 'signalNoiseRatio', label: 'SNR', color: { r: 80, g: 150, b: 255 }, lineWidth: 2 }],
  },
  rates: {
    title: 'Transfer Rates',
    unit: 'Mbps',
    minValue: 0,
    series: [
      { data: 'rxRateMbps', label: 'RX', color: { r: 255, g: 80, b: 80 }, lineWidth: 2 },
      { data: 'txRateMbps', label: 'TX', color: { r: 80, g: 255, b: 80 }, lineWidth: 2 },
    ],
  },
  packets: {
    title: 'Packets',
    series: [
      { data: 'rxPackets', label: 'RX', color: { r: 255, g: 80, b: 80 }, lineWidth: 2 },
      { data: 'txPackets', label: 'TX', color: { r: 80, g: 255, b: 80 }, lineWidth: 2 },
    ],
  },
  bytes: {
    title: 'Bytes',
    series: [
      { data: 'rxBytes', label: 'RX', color: { r: 255, g: 80, b: 80 }, lineWidth: 2 },
      { data: 'txBytes', label: 'TX', color: { r: 80, g: 255, b: 80 }, lineWidth: 2 },
    ],
  },
  bandwidth: {
    title: 'Bandwidth Usage',
    unit: 'Mbps',
    minValue: 0,
    series: [{ data: 'bandwidthUsedMbps', label: 'Bandwidth', color: { r: 100, g: 200, b: 255 }, lineWidth: 2 }],
  },
  quality: {
    title: 'Connection Quality',
    minValue: 0,
    maxValue: 1,
    hideLabels: true,
    series: [
      {
        data: 'qualityExcellent',
        label: 'Excellent',
        fillStyle: 'rgba(76, 175, 80, 0.7)',
        color: { r: 76, g: 175, b: 80 },
        lineWidth: 0,
      },
      {
        data: 'qualityGood',
        label: 'Good',
        fillStyle: 'rgba(139, 195, 74, 0.7)',
        color: { r: 139, g: 195, b: 74 },
        lineWidth: 0,
      },
      {
        data: 'qualityCaution',
        label: 'Caution',
        fillStyle: 'rgba(255, 193, 7, 0.7)',
        color: { r: 255, g: 193, b: 7 },
        lineWidth: 0,
      },
      {
        data: 'qualityWarning',
        label: 'Warning',
        fillStyle: 'rgba(244, 67, 54, 0.7)',
        color: { r: 244, g: 67, b: 54 },
        lineWidth: 0,
      },
      {
        data: 'qualityNone',
        label: 'None',
        fillStyle: 'rgba(128, 128, 128, 0.7)',
        color: { r: 128, g: 128, b: 128 },
        lineWidth: 0,
      },
    ],
  },
  dataAge: {
    title: 'Data Age',
    unit: 'ms',
    series: [{ data: 'dataAgeMs', label: 'Data Age', color: { r: 200, g: 150, b: 100 }, lineWidth: 2 }],
  },
};

export function StationChart({ station, metric, height = '60px' }: StationChartProps) {
  const timeSeries = stationTimeSeries[station];
  const theme = useTheme();

  // Each chart registers the same handler, but the handler deduplicates based on timestamp
  // This ensures data keeps populating even when charts are unmounted/remounted
  useUpdateCallback(handleStatusUpdate);

  const isDarkMode = theme.palette.mode === 'dark';
  const backgroundColor = isDarkMode ? theme.palette.background.paper : '#ffffff';
  const textColor = isDarkMode ? theme.palette.text.primary : '#000000';

  const config = metricConfigs[metric];

  return (
    <Box sx={{ width: '100%', marginBottom: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
      <Box sx={{ width: '100%', '& canvas': { display: 'block', height: `${height} !important` } }}>
        <SmoothieComponent
          responsive
          height={parseInt(height)}
          millisPerPixel={100}
          {...(config.maxValue === undefined && { maxValueScale: 1.05 })}
          {...(config.minValue === undefined && { minValueScale: 1.05 })}
          {...(config.minValue !== undefined && { minValue: config.minValue })}
          {...(config.maxValue !== undefined && { maxValue: config.maxValue })}
          {...(metric === 'bandwidth' && {
            yRangeFunction: (range: { min: number; max: number }) => ({
              min: range.min,
              max: Math.max(range.max, 1),
            }),
          })}
          {...(config.hideLabels
            ? {
                yMinFormatter: () => '',
                yMaxFormatter: () => '',
                yIntermediateFormatter: () => '',
              }
            : {
                yMinFormatter: (value: number) => formatYValue(value, config.unit),
                yMaxFormatter: (value: number) => formatYValue(value, config.unit),
                yIntermediateFormatter: (value: number) => formatYValue(value, config.unit),
              })}
          title={{ text: config.title, fillStyle: textColor, fontSize: 12 }}
          grid={{
            borderVisible: false,
            fillStyle: backgroundColor,
            strokeStyle: isDarkMode ? 'rgba(200,200,200,0.2)' : 'rgba(119,119,119,0.2)',
            verticalSections: 2,
            millisPerLine: 1000,
          }}
          labels={{
            fillStyle: textColor,
            fontSize: 10,
          }}
          series={config.series.map(s => ({
            data: timeSeries[s.data],
            strokeStyle: `rgb(${s.color.r}, ${s.color.g}, ${s.color.b})`,
            lineWidth: s.lineWidth,
            ...(s.fillStyle && { fillStyle: s.fillStyle }),
          }))}
        />
      </Box>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 1,
          padding: 0.5,
          paddingLeft: 1,
          backgroundColor: isDarkMode ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.02)',
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        {config.series.map(item => (
          <Box key={item.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box
              sx={{
                width: 14,
                height: 3,
                backgroundColor: `rgb(${item.color.r}, ${item.color.g}, ${item.color.b})`,
              }}
            />
            <Typography variant="caption" sx={{ fontSize: '0.6rem', lineHeight: 1.2 }}>
              {item.label}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function formatYValue(value: number, unit?: string) {
  const formattedValue = value.toFixed(0);
  return unit ? `${formattedValue} ${unit}` : formattedValue;
}
