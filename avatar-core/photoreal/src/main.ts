import { startPage } from '../../src/spike/photoreal/page.ts';

void startPage().catch((error) => {
  const status = document.getElementById('status');
  if (status) status.textContent = `start failed: ${String(error)}`;
});
