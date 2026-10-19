/*!
 * akta-idwr widget — 東京の感染症 いま、どれくらい？
 * 配置：GitHub Pages（akta-jp.github.io/akta-idwr/widget.js）
 * WordPress 側は骨組みHTML＋このファイルとwidget.cssの読み込みだけを持つ。
 *
 * 変更履歴
 *   2026-10  WordPressのbase64インラインから分離。過去5年の範囲（網掛け）とアニメーションを追加。
 */
(function () {
  var root = document.getElementById('akta-idwr');
  if (!root || root.dataset.init) return;
  root.dataset.init = '1';

  // caveat … データの読み方の但し書き（消さないこと）
  // ※ 疾患ごとの「aktaの一言」は感染研の指摘により削除（2026-09-05）
  // band … 過去5年の範囲（網掛け）を描くか。
  //   エムポックスは2022〜23年の流行が過去5年に含まれ「例年」が定義しにくいため、既定で描かない。
  //   （JIHSも新型コロナだけは別扱いにしている。描く場合は true にするだけでよい）
  var META = {
    hiv:         { label: 'HIV',         color: '#1B7268', band: true,
                   caveat: '国に報告された後天性免疫不全症候群の数です。HIV感染者とAIDS患者の合計で、内訳は含まれません。内訳と確定値はエイズ動向委員会の報告をご覧ください。' },
    syphilis:    { label: '梅毒',        color: '#B23A63', band: true },
    hepatitis_a: { label: 'A型肝炎',     color: '#A9700F', band: true },
    mpox:        { label: 'エムポックス', color: '#3B5EA6', band: false,
                   bandNote: '2022〜23年の流行の影響が大きいため、過去5年の範囲は表示していません。' }
  };
  var ORDER = ['hiv', 'syphilis', 'hepatitis_a', 'mpox'];

  var SPAN_YEAR = 52;    // 「直近1年」で描く週数
  var span = SPAN_YEAR;  // 初期表示。0 なら読み込めた全期間を描く。
  var TABLE_SPAN = 520;  // 数値表に載せる週数の上限（10年）。データが足りなければある分だけ。
  var PAST_YEARS = 4;    // カードに並べる過去年の数（同じ週までの累計）

  // --- 過去5年の範囲（JIHS「グラフで見る感染症流行状況」と同じ考え方） ---
  // 各週について、過去 BASE_YEARS 年の「同じ週の前後 BASE_HALF 週」の報告数を集め、
  // 平均値を下限、平均値＋2×標準偏差を上限とし、移動平均（前後1週）で平滑化する。
  // データの起点より前の年は使えないので、BASE_MIN_YEARS 年分そろえば描く。
  var BASE_YEARS = 5;
  var BASE_HALF = 3;
  var BASE_MIN_YEARS = 4;

  var statusEl = root.querySelector('.ai-status');
  var gridEl   = root.querySelector('.ai-grid');
  var footEl   = root.querySelector('.ai-foot');
  var scope = 'tokyo';
  var DATA = null;
  var INDEX = null;

  // --- アニメーション -------------------------------------------------
  // 動きを減らす設定の人、IntersectionObserver が無い環境では一切動かさない。
  // 既定（CSS）は「表示された状態」。ai-anim が付いたときだけ初期状態を隠すので、
  // スクリプトの途中で失敗しても棒が見えなくなることはない。
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var canAnimate = !reduceMotion && ('IntersectionObserver' in window) && !!window.requestAnimationFrame;
  if (canAnimate) root.classList.add('ai-anim');
  var shown = {};        // 直前に表示していた数値（切り替え時はそこから数え直す）
  var observer = null;

  var nf = function (n) { return (n == null) ? '—' : Number(n).toLocaleString('ja-JP'); };

  // '2026-08-10','2026-08-16' -> '2026年8月10日〜8月16日'
  function jpRange(a, b) {
    if (!a || !b) return '';
    var x = String(a).split('-'), y = String(b).split('-');
    return Number(x[0]) + '年' + Number(x[1]) + '月' + Number(x[2]) + '日〜' +
           (x[0] === y[0] ? '' : Number(y[0]) + '年') + Number(y[1]) + '月' + Number(y[2]) + '日';
  }

  // 増減の符号。変動なしは「±0」と明示する（0と欠測を見分けられるようにするため）
  var signed = function (n) {
    if (n == null) return '—';
    if (n === 0) return '±0';
    return (n > 0 ? '+' : '') + nf(n);
  };

  function fail(msg) {
    statusEl.hidden = false;
    statusEl.textContent = msg;
  }

  // 目盛りを 1 / 2 / 5 × 10^n に丸める。桁が変わっても目盛りは3〜4本に保たれる。
  function niceTicks(max) {
    if (!(max > 0)) return { top: 1, ticks: [0, 1] };
    var raw = max / 2;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    if (step < 1) step = 1;  // 報告数は整数。0.5刻みだと目盛りが「0 / 1 / 1」と重複する。
    var top = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v));
    return { top: top, ticks: ticks };
  }

  // --- 過去5年の範囲の計算 --------------------------------------------
  function buildIndex(weeks) {
    var idx = {};
    for (var i = 0; i < weeks.length; i++) idx[weeks[i].year + '-' + weeks[i].week] = i;
    return idx;
  }

  function baselineAt(weeks, key, sc, year, week) {
    var vals = [], used = 0;
    for (var y = year - 1; y >= year - BASE_YEARS; y--) {
      var j = INDEX[y + '-' + week];
      if (j == null && week === 53) j = INDEX[y + '-52'];  // 53週のない年は第52週で代用
      if (j == null) continue;
      var got = [];
      for (var o = -BASE_HALF; o <= BASE_HALF; o++) {
        var w = weeks[j + o];
        var m = w && w.metrics[key] && w.metrics[key][sc];
        if (m && m.week != null) got.push(m.week);
      }
      if (got.length >= BASE_HALF * 2 - 1) { vals = vals.concat(got); used++; }
    }
    if (used < BASE_MIN_YEARS || vals.length < 2) return null;
    var sum = 0, i;
    for (i = 0; i < vals.length; i++) sum += vals[i];
    var mean = sum / vals.length, ss = 0;
    for (i = 0; i < vals.length; i++) ss += (vals[i] - mean) * (vals[i] - mean);
    var sd = Math.sqrt(ss / (vals.length - 1));
    return { lo: mean, hi: mean + 2 * sd, years: used };
  }

  // 表示中の各週に範囲を付け、前後1週の移動平均で平滑化する。
  function bandFor(series, weeks, key, sc) {
    var raw = series.map(function (d) { return baselineAt(weeks, key, sc, d.year, d.week); });
    return raw.map(function (b, i) {
      if (!b) return null;
      var lo = 0, hi = 0, n = 0;
      for (var o = -1; o <= 1; o++) {
        var r = raw[i + o];
        if (r) { lo += r.lo; hi += r.hi; n++; }
      }
      return { lo: lo / n, hi: hi / n, years: b.years };
    });
  }

  var VB_W = 300, VB_H = 76, PLOT_TOP = 8, BASE_Y = 72;

  // 網掛けのSVGパス。欠けている週で切って、つながっている区間ごとに面を作る。
  function bandPath(band, step, topValue) {
    var h = BASE_Y - PLOT_TOP, out = '', seg = [];
    function yOf(v) { return Math.max(PLOT_TOP, BASE_Y - (v / topValue) * h).toFixed(2); }
    function flush() {
      if (seg.length > 1) {
        var up = seg.map(function (p) { return p.x + ',' + yOf(p.hi); });
        var dn = seg.slice().reverse().map(function (p) { return p.x + ',' + yOf(p.lo); });
        out += 'M' + up.join('L') + 'L' + dn.join('L') + 'Z';
      }
      seg = [];
    }
    for (var i = 0; i < band.length; i++) {
      if (band[i]) seg.push({ x: (i * step + step / 2).toFixed(2), lo: band[i].lo, hi: band[i].hi });
      else flush();
    }
    flush();
    return out;
  }

  function bars(series, color, topValue, ticks, band) {
    var n = series.length, i;
    // 5年（約290本）を描くと1本あたり1px強しかない。
    // 下限1.6pxのままだと棒が隣とくっついて塗りつぶしに見えるので、間隔に応じて細める。
    var step = VB_W / n, bw = Math.max(Math.min(1.6, step * 0.9), step * 0.62);
    var h = BASE_Y - PLOT_TOP;
    var svg = ['<svg class="ai-strip" viewBox="0 0 ' + VB_W + ' ' + VB_H +
               '" preserveAspectRatio="none" role="img" aria-hidden="true">'];

    for (i = 0; i < ticks.length; i++) {
      var gy = BASE_Y - (ticks[i] / topValue) * h;
      var isBase = (ticks[i] === 0);
      svg.push('<line x1="0" y1="' + gy.toFixed(2) + '" x2="' + VB_W + '" y2="' + gy.toFixed(2) +
               '" stroke="' + (isBase ? '#B9C2CB' : '#E3E8ED') + '" stroke-width="1"/>');
    }

    for (i = 0; i < n; i++) {
      if (series[i].week === 1 && i > 0) {
        svg.push('<line x1="' + (i * step).toFixed(2) + '" y1="' + PLOT_TOP + '" x2="' + (i * step).toFixed(2) +
                 '" y2="' + BASE_Y + '" stroke="#C9D0D7" stroke-width="1" stroke-dasharray="2 3"/>');
      }
    }

    // 網掛けは棒の後ろに置く（棒が範囲からはみ出しているかが一目で分かる）
    if (band) {
      var d0 = bandPath(band, step, topValue);
      if (d0) svg.push('<path class="ai-band" d="' + d0 + '"/>');
    }

    // 棒は左から順に伸びる。本数に関係なく全体で約0.7秒に収める。
    for (i = 0; i < n; i++) {
      var d = series[i], x = i * step + (step - bw) / 2;
      var bh = topValue > 0 ? Math.max(d.v > 0 ? 2 : 0, (d.v / topValue) * h) : 0;
      var last = (i === n - 1);
      var delay = Math.round((i / Math.max(1, n - 1)) * 700);
      svg.push('<rect class="ai-bar' + (last ? ' is-now' : '') + '" style="--d:' + delay + 'ms" x="' + x.toFixed(2) +
               '" y="' + (BASE_Y - bh).toFixed(2) +
               '" width="' + bw.toFixed(2) + '" height="' + bh.toFixed(2) +
               '" fill="' + color + '" opacity="' + (last ? 1 : .42) + '"/>');
    }
    svg.push('</svg>');
    return svg.join('');
  }

  // 縦軸つきのグラフ一式。
  // 目盛りの数字はSVGの外（HTML）に置く。SVGは横方向に引き伸ばして描くため、
  // 中に文字を入れるとカード幅によって字が歪む。外に出せばスマホでも読める。
  function plot(series, color, label, band) {
    var max = 0, i;
    for (i = 0; i < series.length; i++) max = Math.max(max, series[i].v || 0);
    var bandMax = 0;
    if (band) for (i = 0; i < band.length; i++) if (band[i]) bandMax = Math.max(bandMax, band[i].hi);
    // 網掛けの上端も目盛りに含める（範囲が描画領域の外に切れないように）
    var nt = niceTicks(Math.max(max, bandMax));
    var h = BASE_Y - PLOT_TOP;

    var widest = 0;
    for (i = 0; i < nt.ticks.length; i++) widest = Math.max(widest, nf(nt.ticks[i]).length);
    // 目盛り数字の桁数から左の余白を決める。桁が急に増えても数字が切れない。
    var gutter = 6 + widest * 7;

    var yticks = nt.ticks.map(function (v) {
      var pct = ((BASE_Y - (v / nt.top) * h) / VB_H) * 100;
      return '<span class="ai-ytick" style="top:' + pct.toFixed(2) + '%">' + nf(v) + '</span>';
    }).join('');

    return '<div class="ai-plot" style="--gut:' + gutter + 'px">' +
        '<p class="ai-ylab">報告数（人）</p>' +
        '<div class="ai-yaxis" aria-hidden="true">' + yticks + '</div>' +
        '<div class="ai-plotwrap">' + bars(series, color, nt.top, nt.ticks, band) + '</div>' +
        '<div class="ai-axis"><span>' + series[0].year + '年 第' + series[0].week + '週</span><span>今週</span></div>' +
        '<p class="ai-sr">' + label + 'の週ごとの報告数。' + series[0].year + '年 第' + series[0].week +
          '週から直近まで' + series.length + '週間分、最大 ' + nf(max) + ' 人。</p>' +
      '</div>';
  }

  // 凡例。網掛けを描いたときだけ「過去5年の範囲」を出す。
  function legend(meta, hasBand) {
    var html = '<div class="ai-legend" aria-hidden="true">' +
      '<span class="ai-key"><i class="ai-sw ai-sw-bar"></i>報告数</span>' +
      (hasBand ? '<span class="ai-key"><i class="ai-sw ai-sw-band"></i>過去5年の範囲</span>' : '') +
      '</div>';
    if (!hasBand && meta.bandNote && span > 0) html += '<p class="ai-bandnote">' + meta.bandNote + '</p>';
    return html;
  }

  function table(weeks, key, sc) {
    var slice = weeks.slice(-TABLE_SPAN);
    var rows = slice.slice().reverse().map(function (w) {
      var m = w.metrics[key] && w.metrics[key][sc];
      return '<tr><td>' + w.year + '年 第' + w.week + '週</td><td>' + nf(m ? m.week : null) + '</td></tr>';
    }).join('');
    var years = Math.round(slice.length / 52 * 10) / 10;
    return '<details><summary>数値表を見る（直近' + slice.length + '週間／約' + years + '年分）</summary>' +
           '<div class="ai-tablewrap"><table>' +
           '<thead><tr><th>週</th><th>報告数</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }

  // --- 数字のカウントアップ ------------------------------------------
  // 画面上の数字だけを動かす。読み上げ用には最終値を別に置いてある（.ai-sr）。
  function countUp(el) {
    var to = Number(el.getAttribute('data-to'));
    var from = Number(el.getAttribute('data-from') || 0);
    if (!canAnimate || isNaN(to) || from === to) { el.textContent = nf(isNaN(to) ? null : to); return; }
    var dur = 800, t0 = null;
    function ease(t) { return 1 - Math.pow(1 - t, 3); }
    function tick(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      el.textContent = nf(Math.round(from + (to - from) * ease(p)));
      if (p < 1) window.requestAnimationFrame(tick);
    }
    el.textContent = nf(from);
    window.requestAnimationFrame(tick);
  }

  function play(card) {
    if (card.classList.contains('is-play')) return;
    card.classList.add('is-play');
    card.querySelectorAll('[data-to]').forEach(countUp);
  }

  function animateCards(firstTime) {
    var cards = gridEl.querySelectorAll('.ai-card');
    if (!canAnimate) return;
    if (observer) observer.disconnect();
    if (firstTime) {
      // 最初は、画面に入ったカードから順に再生する
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { play(e.target); observer.unobserve(e.target); }
        });
      }, { threshold: 0.2 });
      cards.forEach(function (c) { observer.observe(c); });
    } else {
      // 切り替えボタンを押したときは、その場ですぐに描き直す
      root.classList.add('is-switch');
      cards.forEach(play);
    }
  }

  // 数値に data-to / data-from を付けて出力する（カウントアップ用）
  function numSpan(cls, key, value) {
    var prev = shown[key];
    shown[key] = value;
    if (value == null) return '<span class="' + cls + '">' + nf(null) + '</span>';
    var from = canAnimate ? (prev == null ? 0 : prev) : value;
    return '<span class="' + cls + '" aria-hidden="true" data-from="' + from + '" data-to="' + value + '">' +
           nf(canAnimate ? from : value) + '</span>' +
           '<span class="ai-sr">' + nf(value) + '</span>';
  }

  var firstRender = true;

  function render() {
    var weeks = DATA.weeks;
    if (!weeks || !weeks.length) return fail('表示できるデータがありません。data.json を確認してください。');
    if (!INDEX) INDEX = buildIndex(weeks);
    var latest = weeks[weeks.length - 1];
    var scopeLabel = scope === 'tokyo' ? '東京都' : '全国';

    // 集計期間を冒頭に出す。あわせて鮮度も見る。
    // 自動更新が止まったとき、古い数字が「今週」の顔をして残り続けるのが一番まずい。
    var periodEl = root.querySelector('.ai-period');
    if (periodEl) {
      var lag = Math.round((Date.now() - new Date(latest.end + 'T00:00:00+09:00').getTime()) / 86400000);
      periodEl.querySelector('.ai-period-main').textContent = jpRange(latest.start, latest.end);
      periodEl.querySelector('.ai-period-range').textContent =
        latest.year + '年 第' + latest.week + '週（国が集計している1週間の区切り）';
      if (lag > 28) {
        periodEl.classList.add('is-stale');
        periodEl.querySelector('.ai-period-alert').textContent =
          'この期間の終わりから' + lag + '日が経っています。国の公表か、自動更新が止まっている可能性があります。';
      } else {
        periodEl.classList.remove('is-stale');
        periodEl.querySelector('.ai-period-alert').textContent =
          '国の公表にあわせて毎週更新しています' +
          (DATA.generated_at ? '（最終更新：' + DATA.generated_at.slice(0, 10) + '）' : '') + '。';
      }
      periodEl.hidden = false;
    }

    var bandYearsMin = null;  // 実際に何年分で計算できたか（注記に使う）

    gridEl.innerHTML = ORDER.filter(function (k) { return latest.metrics && latest.metrics[k]; }).map(function (k, ci) {
      var meta = META[k];
      var series = (span > 0 ? weeks.slice(-span) : weeks.slice()).map(function (w) {
        var m = w.metrics[k] && w.metrics[k][scope];
        return { year: w.year, week: w.week, v: m ? m.week : null };
      });
      // 網掛けは「直近1年」のときだけ描く。5年表示では、古い週の「過去5年」がデータの起点より前になる。
      var band = (meta.band && span > 0) ? bandFor(series, weeks, k, scope) : null;
      var hasBand = !!(band && band.some(function (b) { return b; }));
      if (hasBand) band.forEach(function (b) {
        if (b) bandYearsMin = (bandYearsMin == null) ? b.years : Math.min(bandYearsMin, b.years);
      });

      var cur = latest.metrics[k][scope] || {};
      var prev = weeks.length > 1 ? (weeks[weeks.length - 2].metrics[k] || {})[scope] : null;
      var diff = (cur.week != null && prev && prev.week != null) ? cur.week - prev.week : null;

      // 去年以前の「同じ週までの累計」を実数でそのまま並べる。
      // 比率（前年比%）も差分も出さない。母数の小さい疾患で暴れるうえ、
      // 何と何を比べたのかが読み手に見えない。実数を並べれば、読み手が自分で確かめられる。
      // データの無い年は自動で飛ばすので、PAST_YEARS を増やしても壊れない。
      // グラフで見えている期間と、下に並ぶ数字の射程をそろえる。
      // 直近1年を見ているときに5年分の累計が並んでいると、どこの話か分からなくなる。
      var nPast = (span > 0 ? 1 : PAST_YEARS);
      var past = [];
      for (var y = latest.year - 1; y >= latest.year - nPast; y--) {
        var j = INDEX[y + '-' + latest.week];
        if (j != null) {
          var pm = weeks[j].metrics[k] && weeks[j].metrics[k][scope];
          if (pm && pm.cum != null) past.push({ year: y, cum: pm.cum });
        }
      }

      var allZero = series.every(function (d) { return !d.v; });

      return '<article class="ai-card" style="--c:' + meta.color + ';--ci:' + ci + '">' +
        '<h3 class="ai-name">' + meta.label + '<span class="ai-scope">' + scopeLabel + '</span></h3>' +
        '<p class="ai-big">' + numSpan('ai-num', k + ':week', cur.week) + '<span class="ai-unit">人 / 今週</span></p>' +
        '<p class="ai-delta">' + (diff == null ? '&nbsp;' : '前の週から ' + signed(diff) + '人') + '</p>' +
        plot(series, meta.color, meta.label, hasBand ? band : null) +
        legend(meta, hasBand) +
        (allZero ? '<p class="ai-delta">この期間の報告は0件です。</p>' : '') +
        '<dl class="ai-rows">' +
          '<div class="ai-row"><dt>今年の累計</dt><dd>' + numSpan('ai-cum', k + ':cum', cur.cum) + ' 人</dd></div>' +
          past.map(function (p) {
            return '<div class="ai-row"><dt>' + p.year + '年の同じ時期</dt><dd>' + nf(p.cum) + ' 人</dd></div>';
          }).join('') +
        '</dl>' +
        (meta.caveat ? '<p class="ai-caveat">' + meta.caveat + '</p>' : '') +
        table(weeks, k, scope) +
      '</article>';
    }).join('');

    var src = DATA.source || {};
    footEl.querySelector('.ai-src').innerHTML =
      '出典：<a href="' + (src.url || '#') + '" target="_blank" rel="noopener">' + (src.name || 'IDWR') + '</a>' +
      (DATA.generated_at ? '　最終更新：' + DATA.generated_at.slice(0, 10) : '');
    footEl.querySelector('.ai-note').textContent = src.note || '';

    // 網掛けの見方（グラフに範囲を描いたときだけ）
    var method = footEl.querySelector('.ai-method');
    if (!method) {
      method = document.createElement('p');
      method.className = 'ai-method';
      footEl.querySelector('.ai-note').insertAdjacentElement('afterend', method);
    }
    if (bandYearsMin != null) {
      method.hidden = false;
      method.textContent =
        '網掛け（過去5年の範囲）は、過去5年間の同じ週の前後3週の報告数の平均値を下限、平均値＋2×標準偏差を上限とし、' +
        '移動平均で平滑化したものです（JIHS「グラフで見る感染症流行状況」と同じ考え方）。' +
        (bandYearsMin < BASE_YEARS ? 'データの起点（' + weeks[0].year + '年）より前の年は含められないため、一部の週は過去' + bandYearsMin + '年分で計算しています。' : '');
    } else {
      method.hidden = true;
    }

    var demoEl = root.querySelector('.ai-demo');
    if (DATA.demo && !demoEl) {
      gridEl.insertAdjacentHTML('beforebegin', '<p class="ai-demo">デモデータを表示しています（実際の報告数ではありません）</p>');
    }
    statusEl.hidden = true;
    gridEl.hidden = false;
    footEl.hidden = false;

    animateCards(firstRender);
    firstRender = false;
  }

  root.querySelectorAll('.ai-controls').forEach(function (group) {
    group.querySelectorAll('.ai-seg').forEach(function (b) {
      b.addEventListener('click', function () {
        group.querySelectorAll('.ai-seg').forEach(function (o) {
          o.classList.remove('is-on');
          o.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('is-on');
        b.setAttribute('aria-pressed', 'true');
        if (b.dataset.scope) scope = b.dataset.scope;
        if (b.dataset.span != null) span = Number(b.dataset.span);
        if (DATA) render();
      });
    });
  });

  var inline = document.getElementById('akta-idwr-fallback');
  if (inline) {
    try { DATA = JSON.parse(inline.textContent); render(); return; } catch (e) {}
  }

  fetch(root.dataset.src, { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (j) { DATA = j; render(); })
    .catch(function () { fail('データを読み込めませんでした。data.json のURLと公開設定を確認してください。'); });
})();
