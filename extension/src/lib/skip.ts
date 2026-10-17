// Sites that are never recorded: banks and money, health portals, adult sites, password managers
// and sign-in pages, plus the person's own list. A site matches with all its subdomains
// (chase.com covers secure.chase.com). Some words in a site's name also count (any "bank" or
// "mychart" site), so a bank that isn't listed is still left out. A site left out by mistake
// costs nothing; one recorded by mistake would.

export const SKIP_GROUPS: { name: string; sites: string[]; words?: string[]; tlds?: string[] }[] = [
  {
    name: 'Banks and money',
    words: ['bank', 'banking', 'creditunion', 'onlinebanking'],
    sites: [
      'paypal.com', 'venmo.com', 'cash.app', 'zellepay.com', 'wise.com', 'transferwise.com', 'revolut.com', 'monzo.com', 'starlingbank.com',
      'n26.com', 'chime.com', 'sofi.com', 'ally.com', 'discover.com', 'americanexpress.com', 'capitalone.com', 'chase.com', 'wellsfargo.com',
      'citi.com', 'citibank.com', 'usbank.com', 'pnc.com', 'truist.com', 'navyfederal.org', 'schwab.com', 'fidelity.com', 'vanguard.com',
      'etrade.com', 'robinhood.com', 'webull.com', 'coinbase.com', 'kraken.com', 'binance.com', 'crypto.com', 'hsbc.com', 'hsbc.co.uk',
      'barclays.co.uk', 'barclaycard.co.uk', 'lloydsbank.com', 'natwest.com', 'rbs.co.uk', 'santander.com', 'santander.co.uk', 'halifax.co.uk',
      'nationwide.co.uk', 'tsb.co.uk', 'firstdirect.com', 'ing.com', 'ing.de', 'ing.nl', 'abnamro.nl', 'rabobank.nl', 'commerzbank.de', 'sparkasse.de',
      'dkb.de', 'comdirect.de', 'credit-agricole.fr', 'societegenerale.fr', 'bnpparibas.com', 'mabanque.bnpparibas', 'rbc.com', 'rbcroyalbank.com',
      'td.com', 'tdbank.com', 'scotiabank.com', 'bmo.com', 'cibc.com', 'commbank.com.au', 'westpac.com.au', 'anz.com', 'anz.com.au', 'nab.com.au',
      'creditkarma.com', 'experian.com', 'equifax.com', 'transunion.com', 'klarna.com', 'affirm.com', 'afterpay.com', 'mint.intuit.com',
      'irs.gov', 'tax.service.gov.uk', 'turbotax.intuit.com',
    ],
  },
  {
    name: 'Health portals',
    words: ['mychart', 'patientportal', 'mypatient', 'patientgateway', 'myhealthrecord'],
    sites: [
      'kp.org', 'myhealth.va.gov', 'followmyhealth.com', 'athenahealth.com', 'zocdoc.com', 'teladoc.com', 'onemedical.com', 'goodrx.com',
      'labcorp.com', 'questdiagnostics.com', 'betterhelp.com', 'talkspace.com', 'cerebral.com', 'plannedparenthood.org', 'hims.com', 'forhers.com',
      'ro.co', 'flo.health', 'helloclue.com', '23andme.com', 'nhsapp.service.nhs.uk', 'my.nhs.uk', 'login.nhs.uk', 'doctolib.de', 'doctolib.fr',
      'livi.co.uk', 'babylonhealth.com', 'healow.com', 'myuhc.com', 'anthem.com', 'aetna.com', 'cigna.com', 'humana.com', 'bcbs.com',
    ],
  },
  {
    name: 'Adult sites',
    words: ['porn', 'xxx', 'xvideos', 'xnxx', 'xhamster', 'hentai', 'nsfw'],
    tlds: ['xxx', 'adult', 'porn', 'sex'],
    sites: [
      'pornhub.com', 'redtube.com', 'youporn.com', 'tube8.com', 'spankbang.com', 'eporner.com', 'beeg.com', 'txxx.com', 'motherless.com',
      'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com', 'livejasmin.com', 'cam4.com', 'camsoda.com',
      'myfreecams.com', 'manyvids.com', 'clips4sale.com', 'brazzers.com', 'erome.com', 'literotica.com', 'nhentai.net', 'rule34.xxx',
      'f95zone.to', 'adultfriendfinder.com', 'ashleymadison.com', 'fetlife.com', 'redgifs.com',
    ],
  },
  {
    name: 'Passwords and sign-in',
    sites: [
      '1password.com', '1password.eu', '1password.ca', 'lastpass.com', 'bitwarden.com', 'bitwarden.eu', 'vault.bitwarden.com', 'dashlane.com',
      'keepersecurity.com', 'keepersecurity.eu', 'nordpass.com', 'roboform.com', 'enpass.io', 'proton.me', 'protonmail.com', 'passwords.google.com',
      'passwords.google', 'accounts.google.com', 'myaccount.google.com', 'login.microsoftonline.com', 'login.live.com', 'account.live.com',
      'account.microsoft.com', 'appleid.apple.com', 'account.apple.com', 'idmsa.apple.com', 'id.apple.com', 'okta.com', 'oktapreview.com',
      'auth0.com', 'onelogin.com', 'duosecurity.com', 'authy.com', 'login.yahoo.com', 'auth.openai.com', 'accounts.firefox.com',
    ],
  },
];

// One site per line (or separated by commas or spaces). Whole addresses work too: only the site is
// kept. Anything that isn't a site name is dropped.
export function parseSkipList(text: string): string[] {
  const out = new Set<string>();
  for (let part of String(text || '').split(/[\s,;]+/)) {
    part = part.trim().toLowerCase();
    if (!part) continue;
    if (/^[a-z]+:\/\//.test(part) || part.includes('/')) {
      try {
        part = new URL(/^[a-z]+:\/\//.test(part) ? part : `https://${part}`).hostname;
      } catch {
        continue;
      }
    }
    part = part.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    if (/^([a-z0-9-]+\.)*[a-z0-9-]+\.[a-z0-9-]{2,}$/.test(part) && part.length <= 253) out.add(part);
  }
  return [...out].slice(0, 500);
}

const covers = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

// Which built-in group leaves this site out, if any.
export function skipGroup(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  const labels = h.split('.');
  const tld = labels[labels.length - 1];
  for (const g of SKIP_GROUPS) {
    if (g.sites.some((s) => covers(h, s))) return g.name;
    if (g.tlds?.includes(tld)) return g.name;
    // The name parts only, not the ending: "bank" in netbank.example.com or mybank.de.
    if (g.words?.some((w) => labels.slice(0, -1).some((l) => l.includes(w)))) return g.name;
  }
  return null;
}

export function isSkipped(host: string, own: readonly string[] = []): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return skipGroup(h) !== null || own.some((s) => covers(h, s));
}
