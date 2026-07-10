const trendApi = globalThis.__gittensoryMinerCalibrationAccuracyTrend;

const CALIBRATION_SNAPSHOTS_STORAGE_KEY = "calibrationAccuracySnapshots";

function buildSparklinePath(values, { width = 120, height = 48 } = {}) {
  if (!values.length) return { linePath: "", areaPath: "", width, height };
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const step = width / Math.max(values.length - 1, 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / range) * (height - 8) - 4;
    return [x, y];
  });
  const linePath = points
    .map(([x, y], index) => (index === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`))
    .join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  const areaPath = `${linePath} L ${last[0].toFixed(1)} ${height} L ${first[0].toFixed(1)} ${height} Z`;
  return { linePath, areaPath, width, height };
}

function renderCalibrationTrendPanel(container, view) {
  container.textContent = "";
  container.hidden = false;
  container.dataset.gittensoryMinerCalibrationTrend = "true";

  const title = document.createElement("h2");
  title.className = "gittensory-miner-calibration-trend__title";
  title.textContent = "Calibration accuracy trend";
  container.appendChild(title);

  const headline = document.createElement("p");
  headline.className = "gittensory-miner-calibration-trend__headline";
  headline.textContent = view.headline;
  container.appendChild(headline);

  if (view.emptyMessage) {
    const empty = document.createElement("p");
    empty.className = "gittensory-miner-calibration-trend__empty";
    empty.textContent = view.emptyMessage;
    container.appendChild(empty);
    return;
  }

  const meta = document.createElement("p");
  meta.className = "gittensory-miner-calibration-trend__meta";
  meta.textContent = `Baseline ${Math.round(view.baseline * 100)}% · ${view.pointCount} snapshot(s) · ${view.trendDirection}`;
  container.appendChild(meta);

  if (view.sparklineValues.length > 0) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "gittensory-miner-calibration-trend__sparkline");
    const { linePath, areaPath, width, height } = buildSparklinePath(view.sparklineValues);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Calibration accuracy trend chart");

    const baselineY = height - ((view.baseline * 100 - Math.min(...view.sparklineValues, view.baseline * 100)) /
      Math.max(Math.max(...view.sparklineValues) - Math.min(...view.sparklineValues), 1)) * (height - 8) - 4;
    const baseline = document.createElementNS("http://www.w3.org/2000/svg", "line");
    baseline.setAttribute("x1", "0");
    baseline.setAttribute("x2", String(width));
    baseline.setAttribute("y1", baselineY.toFixed(1));
    baseline.setAttribute("y2", baselineY.toFixed(1));
    baseline.setAttribute("stroke", "currentColor");
    baseline.setAttribute("stroke-dasharray", "3 3");
    baseline.setAttribute("opacity", "0.5");

    const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
    area.setAttribute("d", areaPath);
    area.setAttribute("fill", "color-mix(in oklab, currentColor 18%, transparent)");

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", linePath);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.5");

    svg.append(area, baseline, line);
    container.appendChild(svg);
  }
}

function projectCalibrationTrendFromSnapshots(snapshots, options = {}) {
  return trendApi.buildCalibrationAccuracyTrendView(snapshots, options);
}

const calibrationTrendPanelApi = {
  CALIBRATION_SNAPSHOTS_STORAGE_KEY,
  buildSparklinePath,
  renderCalibrationTrendPanel,
  projectCalibrationTrendFromSnapshots,
};

globalThis.__gittensoryMinerCalibrationTrendPanel = calibrationTrendPanelApi;

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerCalibrationTrendInternals = calibrationTrendPanelApi;
}
