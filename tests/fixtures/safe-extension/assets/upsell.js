const root = document.querySelector('.upsell');
const settings = JSON.parse(document.getElementById('upsell-data').textContent);
root.querySelector('h2').textContent = settings.heading;
root.innerHTML = '';
