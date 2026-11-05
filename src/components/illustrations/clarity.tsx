import { home } from "@/content/home";
export function ClarityIllustration() {
  return (
    <figure className="clarity-figure">
      <svg
        className="clarity-diagram"
        viewBox="0 0 560 530"
        role="img"
        aria-labelledby="clarity-title clarity-desc"
      >
        <title id="clarity-title">{home.hero.visual.title}</title>
        <desc id="clarity-desc">{home.hero.visual.description}</desc>
        <defs>
          <pattern id="clarity-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill="currentColor" opacity=".22" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="560" height="530" fill="url(#clarity-grid)" opacity=".45" />
        <g stroke="currentColor" strokeWidth="1" fill="none">
          <path d="M8 48h36M8 48v36M516 48h36v36M8 454v28h36M516 482h36v-28" opacity=".35" />
          <path d="M20 125h78l65 65h70M38 257h195M5 390h92l70-72h66" className="clarity-stream" />
          <path d="M51 146h56l54 58h72M70 279h163M42 413h65l63-73h63" opacity=".22" />
          <path d="M233 190v150M233 265h50" opacity=".6" />
          <rect x="222" y="253" width="22" height="22" fill="var(--background)" />
          <rect x="227" y="258" width="12" height="12" opacity=".5" />
          <path d="M284 176l106-60 122 69v141l-106 62-122-70z" strokeWidth="1.2" />
          <path
            d="M284 176l122 70 106-61M406 246v142M284 211l122 70 106-61M284 247l122 70 106-61M284 282l122 70 106-61M315 194v141M345 211v142M376 229v142M432 231v141M459 215v141M485 200v140"
            opacity=".47"
          />
          <path d="M284 176v142l122 70V246z" fill="currentColor" fillOpacity=".025" />
          <path d="M390 116v-23h78M512 326h18v53" opacity=".4" />
        </g>
        <g fill="var(--background)" stroke="currentColor" strokeWidth="1">
          <rect x="21" y="114" width="22" height="22" />
          <rect x="62" y="246" width="22" height="22" />
          <rect x="23" y="379" width="22" height="22" />
          <circle cx="104" cy="125" r="3" />
          <circle cx="167" cy="257" r="3" />
          <circle cx="129" cy="357" r="3" />
        </g>
        <g fill="currentColor">
          <circle cx="119" cy="85" r="2" opacity=".3" />
          <circle cx="160" cy="117" r="2" opacity=".4" />
          <rect x="105" y="323" width="4" height="4" opacity=".4" />
          <rect x="54" y="329" width="3" height="3" opacity=".3" />
          <circle cx="189" cy="400" r="2" opacity=".4" />
          <circle cx="459" cy="95" r="2" />
        </g>
        <g className="diagram-label" fill="currentColor">
          <text x="20" y="49">
            {home.hero.visual.topLabel.toUpperCase()}
          </text>
          <text x="18" y="449">
            {home.hero.visual.inputs}
          </text>
          <text x="305" y="449">
            {home.hero.visual.output}
          </text>
          <text x="20" y="510">
            {home.hero.visual.bottomLabel.toUpperCase()}
          </text>
        </g>
      </svg>
      <figcaption>{home.hero.visual.caption}</figcaption>
    </figure>
  );
}
