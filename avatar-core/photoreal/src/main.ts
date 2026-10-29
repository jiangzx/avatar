const status = document.getElementById('status');
if (!status) throw new Error('#status missing');
status.textContent = `WebGPU: ${'gpu' in navigator ? 'yes' : 'no'}\nphotoreal scaffold`;

export {};
