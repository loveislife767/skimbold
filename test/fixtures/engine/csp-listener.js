// Records every CSP violation on the page, including ones caused by extension content scripts.
window.cspViolations = [];
document.addEventListener('securitypolicyviolation', (event) => {
  window.cspViolations.push(`${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`);
});
