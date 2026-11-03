/* Sizlio shared currency helper — load before screen scripts */
(function (global) {
  const COUNTRY_CURRENCY = {
    PK: { currency_code: 'PKR', currency_symbol: 'Rs', locale: 'en-PK' },
    AE: { currency_code: 'AED', currency_symbol: 'AED', locale: 'en-AE' },
    SA: { currency_code: 'SAR', currency_symbol: 'SAR', locale: 'en-SA' },
    BH: { currency_code: 'BHD', currency_symbol: 'BD', locale: 'en-BH' },
    QA: { currency_code: 'QAR', currency_symbol: 'QR', locale: 'en-QA' },
    GB: { currency_code: 'GBP', currency_symbol: '£', locale: 'en-GB' },
    US: { currency_code: 'USD', currency_symbol: '$', locale: 'en-US' }
  };

  let state = {
    country_code: 'PK',
    currency_code: 'PKR',
    currency_symbol: 'Rs',
    locale: 'en-PK'
  };

  function applyFromSettings(settings) {
    if (!settings || typeof settings !== 'object') return state;
    const cc = String(settings.country_code || state.country_code || 'PK').toUpperCase();
    const map = COUNTRY_CURRENCY[cc] || COUNTRY_CURRENCY.PK;
    state = {
      country_code: cc in COUNTRY_CURRENCY ? cc : 'PK',
      currency_code: settings.currency_code || map.currency_code,
      currency_symbol: settings.currency_symbol || map.currency_symbol,
      locale: map.locale
    };
    return state;
  }

  function setCountry(countryCode) {
    const cc = String(countryCode || 'PK').toUpperCase();
    const map = COUNTRY_CURRENCY[cc] || COUNTRY_CURRENCY.PK;
    state = {
      country_code: cc in COUNTRY_CURRENCY ? cc : 'PK',
      currency_code: map.currency_code,
      currency_symbol: map.currency_symbol,
      locale: map.locale
    };
    return state;
  }

  function money(n, opts) {
    const amount = Number(n || 0);
    const max = (opts && opts.maxFractionDigits != null) ? opts.maxFractionDigits : 2;
    const min = (opts && opts.minFractionDigits != null) ? opts.minFractionDigits : 0;
    try {
      return state.currency_symbol + ' ' + amount.toLocaleString(state.locale, {
        minimumFractionDigits: min,
        maximumFractionDigits: max
      });
    } catch (_) {
      return state.currency_symbol + ' ' + amount.toFixed(Math.min(2, max));
    }
  }

  function getState() {
    return Object.assign({}, state);
  }

  global.SizlioCurrency = {
    COUNTRY_CURRENCY,
    applyFromSettings,
    setCountry,
    money,
    getState,
    get symbol() { return state.currency_symbol; },
    get code() { return state.currency_code; },
    get country() { return state.country_code; }
  };
})(typeof window !== 'undefined' ? window : global);
