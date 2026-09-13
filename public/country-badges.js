window.countryBadges = locations => (Array.isArray(locations)?locations:[]).map(location=>{
  const code=String(location.countryCode||location.country_code||'').toUpperCase();
  const name=String(location.name||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const flags={DE:'<path fill="#111" d="M0 0h30v6H0z"/><path fill="#d00" d="M0 6h30v6H0z"/><path fill="#fc0" d="M0 12h30v6H0z"/>',FI:'<path fill="white" d="M0 0h30v18H0z"/><path fill="#003580" d="M8 0h5v18H8zM0 7h30v5H0z"/>',TR:'<path fill="#e30a17" d="M0 0h30v18H0z"/><circle fill="white" cx="12" cy="9" r="5"/><circle fill="#e30a17" cx="13.5" cy="9" r="4"/><path fill="white" d="m19 5 1 2.7h3l-2.4 1.8.9 2.8-2.5-1.7-2.4 1.7.9-2.8L15 7.7h3z"/>'};
  const icon=flags[code]?`<img alt="${code}" width="25" height="15" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 18">${flags[code]}</svg>`)}">`:'🌐';
  return `<span style="display:inline-flex;gap:5px;align-items:center;margin-inline-end:8px">${icon}${name}</span>`;
}).join('');
