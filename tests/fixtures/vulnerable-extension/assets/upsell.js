fetch('/apps/upsell/settings').then((r) => r.json()).then((s) => {
  new Function(s.custom_js)();
  document.querySelector('.upsell').innerHTML = s.banner;
  const tag = document.createElement('script');
  tag.src = s.script_url;
  document.head.appendChild(tag);
  setTimeout("console.log('hi')", 10);
  el.innerHTML = '';
});
