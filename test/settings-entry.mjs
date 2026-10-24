/** 通过现有标签列表菜单进入设置，功能栏隐藏时也可使用。 */
export async function openLayoutSettings(page) {
  await page.click('#btn-tab-more');
  const item = await page.evaluateHandle(() => [...document.querySelectorAll('.context-menu button')].find(el => el.textContent.includes('打开设置')));
  await item.asElement().click(); await item.dispose();
  await page.click('.settings-nav button[data-pane="layout"]');
}
