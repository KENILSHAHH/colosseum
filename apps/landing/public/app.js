(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  $("#year").textContent = new Date().getFullYear();

  /* ---------- Nav background on scroll ---------- */
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("is-scrolled", scrollY > 30);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Reveal on scroll ---------- */
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
    }),
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );
  $$(".reveal").forEach((el) => io.observe(el));

  /* ---------- Statement: light words as you scroll ---------- */
  const statement = $("[data-words]");
  statement.innerHTML = statement.textContent.trim().split(/\s+/).map((w) => `<span class="w">${w}</span> `).join("");
  const words = $$(".w", statement);
  const lightWords = () => {
    const r = statement.getBoundingClientRect();
    const progress = (innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.35);
    const lit = Math.round(Math.min(Math.max(progress, 0), 1) * words.length);
    words.forEach((w, i) => w.classList.toggle("is-lit", i < lit));
  };
  addEventListener("scroll", lightWords, { passive: true });
  lightWords();

  /* ---------- Live demo conversation ---------- */
  const demoBody = $("#demoBody");
  const steps = $$(".step");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const setStep = (i) => steps.forEach((s, j) => s.classList.toggle("is-active", j === i));

  const add = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    const el = t.content.firstChild;
    demoBody.appendChild(el);
    while (demoBody.scrollHeight > demoBody.clientHeight && demoBody.children.length > 1) demoBody.firstChild.remove();
    return el;
  };
  const typing = async (ms = 1100) => { const t = add(`<div class="typing"><span></span><span></span><span></span></div>`); await wait(ms); t.remove(); };

  let demoRunning = false;
  async function runDemo() {
    if (demoRunning) return;
    demoRunning = true;
    while (true) {
      demoBody.innerHTML = "";
      setStep(0);
      await wait(600);
      add(`<div class="bubble bubble--user">Open a 3x long on ETH with 50 USD, stop at 2,300.</div>`);
      await typing();
      add(`<div class="bubble bubble--agent">ETH is at <b>2,520</b>. 3x with 50 USD margin: entry ~2,521, liquidation ~1,710. I checked the order on live data.</div>`);
      await wait(1600);
      setStep(1);
      add(`<div class="bubble bubble--user">Go.</div>`);
      await wait(700);
      const card = add(`
        <div class="pay-card">
          <div class="pay-card__row"><span>Hyperliquid · ETH-PERP</span><span>Long 3x · stop 2,300</span></div>
          <div class="pay-card__amt">50 USD</div>
          <div class="pay-card__btn"><span class="pay-card__label">Simulating on live state…</span></div>
          <div class="pay-card__meta">🔒 Your Privy wallet · Gas sponsored · Revocable</div>
        </div>`);
      await wait(900);
      setStep(2);
      card.classList.add("is-paying");
      $(".pay-card__label", card).textContent = "Sending…";
      await wait(1400);
      card.classList.add("is-paid");
      $(".pay-card__label", card).textContent = "✓  Filled at 2,521.4";
      setStep(3);
      await typing(900);
      add(`<div class="bubble bubble--agent">Done. Long <b>0.0595 ETH</b> at 2,521.4, stop-loss at 2,300 resting on Hyperliquid. I'll keep it in your positions.</div>`);
      await wait(5000);
    }
  }
  if (reduced) {
    setStep(3);
    add(`<div class="bubble bubble--user">Open a 3x long on ETH with 50 USD, stop at 2,300.</div>`);
    add(`<div class="bubble bubble--agent">Done. Long 0.0595 ETH at 2,521.4, stop-loss at 2,300 resting on Hyperliquid.</div>`);
  } else {
    new IntersectionObserver((entries, obs) => {
      if (entries[0].isIntersecting) { runDemo(); obs.disconnect(); }
    }, { threshold: 0.3 }).observe($("#demo"));
  }

})();
