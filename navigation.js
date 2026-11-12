'use strict';
(() => {
  const panels=[...document.querySelectorAll('[data-page-panel]')];
  const links=[...document.querySelectorAll('.menu-link[data-page],.menu-link[data-trend]')];
  if(!panels.length||!links.length)return;

  for(const link of links){
    link.addEventListener('click',()=>{
      const trend=link.dataset.trend||'';
      const page=link.dataset.page||'trend';
      panels.forEach(panel=>{panel.hidden=panel.dataset.pagePanel!==page;});
      for(const item of document.querySelectorAll('.menu-link')){
        item.classList.toggle('active',item===link);
      }
      const trendGroup=document.querySelector('.menu-trends');
      if(trendGroup)trendGroup.open=false;
      window.dispatchEvent(new CustomEvent('donation-log:close-menu',{detail:{returnFocus:false}}));
      if(trend)window.dispatchEvent(new CustomEvent('donation-log:trend-selected',{detail:{trend}}));
    });
  }
})();
