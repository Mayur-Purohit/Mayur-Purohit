const fs = require('fs');
const path = require('path');
const https = require('https');

const USERNAME = process.env.USERNAME || 'Mayur-Purohit';
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(__dirname, '../../dist/stats/activity-graph.svg');

async function fetchContributions(username) {
  // Method 1: Try GitHub GraphQL API if token is provided
  if (process.env.GITHUB_TOKEN) {
    try {
      const now = new Date();
      const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      const from = new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000).toISOString();
      const query = JSON.stringify({
        query: `query userInfo($LOGIN: String!, $FROM: DateTime!, $TO: DateTime!) {
          user(login: $LOGIN) {
            contributionsCollection(from: $FROM, to: $TO) {
              contributionCalendar {
                weeks {
                  contributionDays {
                    contributionCount
                    date
                  }
                }
              }
            }
          }
        }`,
        variables: { LOGIN: username, FROM: from, TO: to }
      });

      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${process.env.GITHUB_TOKEN}`,
          'User-Agent': 'Node-Activity-Graph-Generator',
          'Content-Type': 'application/json'
        },
        body: query
      });

      if (res.ok) {
        const json = await res.json();
        if (json.data && json.data.user && json.data.user.contributionsCollection) {
          const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
          const days = [];
          for (const week of weeks) {
            for (const d of week.contributionDays) {
              days.push({ date: d.date, count: d.contributionCount });
            }
          }
          days.sort((a, b) => a.date.localeCompare(b.date));
          if (days.length >= 31) {
            console.log('Successfully fetched contributions via GitHub GraphQL API');
            return days.slice(-31);
          }
        }
      }
    } catch (err) {
      console.warn('GraphQL fetch failed, falling back to public page:', err.message);
    }
  }

  // Method 2: Fetch public contribution calendar (zero authentication required, reliable)
  const res = await fetch(`https://github.com/users/${username}/contributions`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch contributions: HTTP ${res.status}`);
  }
  const html = await res.text();

  const days = [];
  const rx = /<td[^>]*data-date="(\d{4}-\d{2}-\d{2})"[^>]*id="([^"]+)"/g;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const date = m[1];
    const id = m[2];
    const tipRx = new RegExp('<tool-tip[^>]*for="' + id + '"[^>]*>([^<]+)</tool-tip>');
    const tipMatch = tipRx.exec(html);
    let count = 0;
    if (tipMatch) {
      const text = tipMatch[1].trim();
      const cm = text.match(/^(\d+)/);
      if (cm) count = parseInt(cm[1], 10);
    }
    days.push({ date, count });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  if (days.length < 31) {
    throw new Error(`Could not parse sufficient contribution days (found ${days.length})`);
  }
  console.log('Successfully fetched contributions via GitHub public calendar');
  return days.slice(-31);
}

function generateSvg(days) {
  const width = 1200;
  const height = 420;
  const padLeft = 70;
  const padRight = 50;
  const padTop = 85;
  const padBottom = 50;

  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;

  const maxVal = Math.max(5, ...days.map(d => d.count));
  // Y-axis steps: 5 divisions
  const yStep = Math.ceil(maxVal / 5) || 1;
  const yMax = yStep * 5;

  // Calculate points
  const points = days.map((d, i) => {
    const x = padLeft + (i / (days.length - 1)) * chartWidth;
    const y = padTop + chartHeight - (d.count / yMax) * chartHeight;
    return { x, y, count: d.count, date: d.date };
  });

  // Generate smooth cubic bezier path
  let pathD = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    pathD += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  const areaD = `${pathD} L ${points[points.length - 1].x.toFixed(2)} ${(padTop + chartHeight).toFixed(2)} L ${points[0].x.toFixed(2)} ${(padTop + chartHeight).toFixed(2)} Z`;

  // Grid lines and labels
  let yGridSvg = '';
  for (let i = 0; i <= 5; i++) {
    const val = yStep * i;
    const y = padTop + chartHeight - (val / yMax) * chartHeight;
    yGridSvg += `
      <line class="ct-grid ct-vertical" x1="${padLeft}" y1="${y.toFixed(2)}" x2="${padLeft + chartWidth}" y2="${y.toFixed(2)}"/>
      <text class="ct-label ct-vertical ct-start" x="${padLeft - 15}" y="${(y + 4).toFixed(2)}" text-anchor="end">${val}</text>
    `;
  }

  let xGridSvg = '';
  let xLabelsSvg = '';
  // Show every 2nd or 3rd date label for readability
  days.forEach((d, i) => {
    const p = points[i];
    xGridSvg += `
      <line class="ct-grid ct-horizontal" x1="${p.x.toFixed(2)}" y1="${padTop}" x2="${p.x.toFixed(2)}" y2="${padTop + chartHeight}"/>
    `;

    // Format date as "Aug 22" or "22"
    const dateObj = new Date(d.date + 'T00:00:00Z');
    const dayOfMonth = dateObj.getUTCDate();
    const monthName = dateObj.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const label = (i === 0 || dayOfMonth === 1 || i === days.length - 1 || i % 3 === 0) ? `${monthName} ${dayOfMonth}` : '';

    if (label) {
      xLabelsSvg += `
        <text class="ct-label ct-horizontal" x="${p.x.toFixed(2)}" y="${padTop + chartHeight + 22}" text-anchor="middle">${label}</text>
      `;
    }
  });

  let pointsSvg = '';
  points.forEach((p) => {
    pointsSvg += `
      <circle class="ct-point" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4">
        <title>${p.date}: ${p.count} contribution${p.count === 1 ? '' : 's'}</title>
      </circle>
    `;
  });

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect xmlns="http://www.w3.org/2000/svg" data-testid="card_bg" id="cardBg"
    x="0.5" y="0.5" rx="8" height="${height - 1}" width="${width - 1}"
    fill="#0d1117" stroke="#7C3AED" stroke-opacity="0.3" stroke-width="1"/>

  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }
    .header {
      font: 600 20px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      text-align: center;
      color: #C084FC;
      margin: 0;
      padding-top: 22px;
      letter-spacing: 0.5px;
    }
    .ct-label {
      fill: #C084FC;
      font-size: 11px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
    }
    .ct-grid {
      stroke: #C084FC;
      stroke-width: 1px;
      stroke-opacity: 0.15;
      stroke-dasharray: 3px;
    }
    .ct-line {
      fill: none;
      stroke: #7C3AED;
      stroke-width: 3.5px;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 5000;
      stroke-dashoffset: 5000;
      animation: dash 3s ease-in-out forwards;
    }
    .ct-point {
      fill: #EDE9FE;
      stroke: #7C3AED;
      stroke-width: 2px;
      transition: r 0.2s ease;
      animation: blink 1s ease-in-out forwards;
    }
    .ct-area {
      fill: #A855F7;
      fill-opacity: 0.18;
      stroke: none;
    }
    .axis-title {
      fill: #A855F7;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    @keyframes blink {
      from {
        opacity: 0;
        transform: scale(0.5);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    @keyframes dash {
      to {
        stroke-dashoffset: 0;
      }
    }
  </style>

  <!-- Title -->
  <foreignObject x="0" y="0" width="${width}" height="60">
    <h1 xmlns="http://www.w3.org/1999/xhtml" class="header">
      Mayur's Contribution Activity
    </h1>
  </foreignObject>

  <!-- Axis Titles -->
  <text class="axis-title" x="${padLeft}" y="70" text-anchor="start">Contributions</text>
  <text class="axis-title" x="${width - padRight}" y="${padTop + chartHeight + 42}" text-anchor="end">Last 31 Days</text>

  <!-- Grids -->
  <g class="ct-grids">
    ${yGridSvg}
    ${xGridSvg}
  </g>

  <!-- Chart Area and Line -->
  <g class="ct-chart">
    <path class="ct-area" d="${areaD}"/>
    <path class="ct-line" d="${pathD}"/>
    <g class="ct-points">
      ${pointsSvg}
    </g>
  </g>

  <!-- Labels -->
  <g class="ct-labels">
    ${xLabelsSvg}
  </g>
</svg>
`;
}

async function run() {
  try {
    const days = await fetchContributions(USERNAME);
    const svg = generateSvg(days);
    
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(OUTPUT_PATH, svg, 'utf8');
    console.log(`Generated activity graph at: ${OUTPUT_PATH} (${Buffer.byteLength(svg, 'utf8')} bytes)`);
  } catch (err) {
    console.error('Error generating activity graph:', err);
    process.exit(1);
  }
}

run();
