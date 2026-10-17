// Searches read from search pages' addresses, as browsers really record them: the words, where
// they were searched, and an address with nothing but the words.

import { describe, expect, it } from 'vitest';
import { findSearch } from './search';

const q = (url: string) => findSearch(url)?.query ?? null;
const engine = (url: string) => findSearch(url)?.engine ?? null;

describe('Google', () => {
  it('reads the words from every shape of results page', () => {
    const cases: [string, string][] = [
      ['https://www.google.com/search?q=protein+bars&oq=protein+bars&gs_lcrp=EgZjaHJvbWUyBggAEEUYOTIHCAEQABiABDIHCAIQABiABNIBCDI0NjFqMGo3qAIAsAIA&sourceid=chrome&ie=UTF-8', 'protein bars'],
      ['https://www.google.com/search?client=firefox-b-d&q=how+to+do+a+pull+up', 'how to do a pull up'],
      ['https://www.google.co.uk/search?q=weather%20london&sca_esv=123&source=hp&ei=abc', 'weather london'],
      ['https://www.google.de/search?q=K%C3%B6ln+Wetter', 'Köln Wetter'],
      ['https://www.google.com.au/search?q=bunnings+hours', 'bunnings hours'],
      ['https://google.com/search?q=plain', 'plain'],
      ['https://www.google.com/search?q=cats&tbm=isch&ved=0ahUKEwi', 'cats'],
      ['https://www.google.com/search?sca_esv=1&q=%22exact+phrase%22+-minus&start=10', '"exact phrase" -minus'],
      ['https://www.google.com/webhp?hl=en#q=old+style+hash', 'old style hash'],
      ['https://www.google.com/#q=hash+only', 'hash only'],
      ['https://www.google.com/?q=root+query', 'root query'],
      ['https://images.google.com/search?q=mountains', 'mountains'],
      ['https://scholar.google.com/scholar?q=sleep+and+muscle+growth', 'sleep and muscle growth'],
      ['https://www.google.com/search?q=++lots+++of+++spaces++', 'lots of spaces'],
    ];
    for (const [url, words] of cases) {
      expect(q(url), url).toBe(words);
      expect(engine(url), url).toBe('google');
    }
  });

  it('keeps only the words in the address', () => {
    expect(findSearch('https://www.google.com/search?q=protein+bars&oq=protein&sourceid=chrome&ie=UTF-8#ip=1')).toEqual({
      engine: 'google',
      name: 'Google',
      query: 'protein bars',
      url: 'https://www.google.com/search?q=protein%20bars',
    });
  });

  it("isn't fooled by Google pages that aren't searches", () => {
    for (const url of [
      'https://www.google.com/',
      'https://www.google.com/search',
      'https://www.google.com/search?q=',
      'https://www.google.com/search?q=+++',
      'https://www.google.com/url?q=https://example.com&sa=D',
      'https://www.google.com/imgres?imgurl=x&q=cat',
      'https://docs.google.com/document/d/abc/edit?q=x',
      'https://accounts.google.com/signin?q=x',
      'https://mail.google.com/mail/u/0/#search/invoice',
      'https://notgoogle.com/search?q=x',
      'https://google.evil.example/search?q=x',
    ]) {
      expect(findSearch(url), url).toBeNull();
    }
  });
});

describe('maps', () => {
  it('reads Google Maps searches and drops where the map was', () => {
    const s = findSearch('https://www.google.com/maps/search/coffee+near+me/@51.5072,-0.1276,14z/data=!3m1!4b1?entry=ttu');
    expect(s).toMatchObject({ engine: 'google-maps', name: 'Google Maps', query: 'coffee near me' });
    expect(s!.url).toBe('https://www.google.com/maps/search/coffee%20near%20me');
    expect(s!.url).not.toContain('51.5');
    expect(q('https://www.google.com/maps/search/Caf%C3%A9+de+Flore/')).toBe('Café de Flore');
    expect(q('https://www.google.com/maps?q=eiffel+tower&hl=en')).toBe('eiffel tower');
    expect(q('https://maps.google.com/?q=1600+Amphitheatre+Parkway')).toBe('1600 Amphitheatre Parkway');
    expect(q('https://maps.google.co.uk/maps/search/gym/@51.5,-0.1,13z')).toBe('gym');
    expect(engine('https://www.google.com/maps/search/gym')).toBe('google-maps');
  });

  it('reads Apple Maps, Bing Maps and OpenStreetMap', () => {
    expect(findSearch('https://maps.apple.com/?q=Ferry+Building&ll=37.79,-122.39')).toMatchObject({ engine: 'apple-maps', query: 'Ferry Building', url: 'https://maps.apple.com/?q=Ferry%20Building' });
    expect(findSearch('https://www.bing.com/maps?q=central+park&cp=40.7~-73.9&lvl=14')).toMatchObject({ engine: 'bing-maps', query: 'central park' });
    expect(findSearch('https://www.openstreetmap.org/search?query=Brandenburger%20Tor#map=17/52.51/13.37')).toMatchObject({ engine: 'osm', query: 'Brandenburger Tor' });
  });

  it("doesn't count a map without a search", () => {
    expect(findSearch('https://www.google.com/maps/@51.5072,-0.1276,14z')).toBeNull();
    expect(findSearch('https://www.google.com/maps/place/Big+Ben/@51.5,-0.12,17z')).toBeNull();
    expect(findSearch('https://www.google.com/maps/dir/Home/Work/')).toBeNull();
  });
});

describe('Bing and DuckDuckGo', () => {
  it('reads Bing', () => {
    expect(findSearch('https://www.bing.com/search?q=best+running+shoes&form=QBLH&sp=-1&pq=best+running&sc=10-12&qs=n&sk=&cvid=ABC')).toMatchObject({
      engine: 'bing',
      query: 'best running shoes',
      url: 'https://www.bing.com/search?q=best%20running%20shoes',
    });
    expect(q('https://www.bing.com/images/search?q=puppies&form=HDRSC2')).toBe('puppies');
    expect(q('https://www.bing.com/videos/search?q=squat+form')).toBe('squat form');
    expect(q('https://www.bing.com/news/search?q=elections')).toBe('elections');
    expect(q('https://cn.bing.com/search?q=%E5%A4%A9%E6%B0%94')).toBe('天气');
    expect(findSearch('https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbQ&ntb=1')).toBeNull();
    expect(findSearch('https://www.bing.com/')).toBeNull();
  });

  it('reads DuckDuckGo, its HTML and lite pages too', () => {
    expect(findSearch('https://duckduckgo.com/?q=privacy+tools&t=h_&ia=web')).toMatchObject({ engine: 'duckduckgo', query: 'privacy tools', url: 'https://duckduckgo.com/?q=privacy%20tools' });
    expect(q('https://duckduckgo.com/?t=ffab&q=!w+octopus&ia=web')).toBe('!w octopus');
    expect(q('https://html.duckduckgo.com/html/?q=no+javascript')).toBe('no javascript');
    expect(q('https://lite.duckduckgo.com/lite/?q=tiny')).toBe('tiny');
    expect(findSearch('https://duckduckgo.com/')).toBeNull();
    expect(findSearch('https://duckduckgo.com/settings')).toBeNull();
  });
});

describe('YouTube, Amazon, Reddit, Wikipedia', () => {
  it('reads YouTube and YouTube Music searches', () => {
    expect(findSearch('https://www.youtube.com/results?search_query=calisthenics+beginner+routine&sp=EgIQAQ%253D%253D')).toMatchObject({
      engine: 'youtube',
      name: 'YouTube',
      query: 'calisthenics beginner routine',
      url: 'https://www.youtube.com/results?search_query=calisthenics%20beginner%20routine',
    });
    expect(q('https://m.youtube.com/results?search_query=lofi')).toBe('lofi');
    expect(findSearch('https://music.youtube.com/search?q=daft+punk')).toMatchObject({ engine: 'youtube-music', query: 'daft punk' });
    expect(findSearch('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toBeNull();
    expect(findSearch('https://www.youtube.com/results')).toBeNull();
  });

  it('reads Amazon in any country', () => {
    expect(findSearch('https://www.amazon.com/s?k=resistance+bands&crid=2M096C61O4MLT&sprefix=resistance%2Caps%2C283&ref=nb_sb_noss_1')).toMatchObject({
      engine: 'amazon',
      query: 'resistance bands',
      url: 'https://www.amazon.com/s?k=resistance%20bands',
    });
    expect(q('https://www.amazon.co.uk/s?k=kettlebell&i=sports')).toBe('kettlebell');
    expect(q('https://www.amazon.de/s?k=Klimmzugstange')).toBe('Klimmzugstange');
    expect(q('https://www.amazon.co.jp/s?k=%E6%9C%AC')).toBe('本');
    expect(q('https://www.amazon.com.br/s?k=livro')).toBe('livro');
    expect(q('https://www.amazon.com/s/ref=nb_sb_noss?url=search-alias%3Daps&field-keywords=yoga+mat')).toBe('yoga mat');
    expect(findSearch('https://www.amazon.com/dp/B07XYZ?k=x')).toBeNull();
    expect(findSearch('https://www.amazon.com/gp/cart/view.html')).toBeNull();
  });

  it('reads Reddit searches, site-wide and in a subreddit', () => {
    expect(findSearch('https://www.reddit.com/search/?q=best+budget+headphones&type=link')).toMatchObject({
      engine: 'reddit',
      query: 'best budget headphones',
      url: 'https://www.reddit.com/search?q=best%20budget%20headphones',
    });
    expect(findSearch('https://www.reddit.com/r/bodyweightfitness/search/?q=dips&restrict_sr=1')).toMatchObject({ query: 'dips', url: 'https://www.reddit.com/r/bodyweightfitness/search?q=dips' });
    expect(q('https://old.reddit.com/search?q=old+style')).toBe('old style');
    expect(findSearch('https://www.reddit.com/r/bodyweightfitness/comments/abc/title/')).toBeNull();
  });

  it('reads Wikipedia searches in any language', () => {
    expect(findSearch('https://en.wikipedia.org/w/index.php?search=photosynthesis&title=Special%3ASearch&ns0=1')).toMatchObject({
      engine: 'wikipedia',
      query: 'photosynthesis',
      url: 'https://en.wikipedia.org/w/index.php?search=photosynthesis',
    });
    expect(q('https://en.wikipedia.org/wiki/Special:Search?search=black+hole&go=Go')).toBe('black hole');
    expect(q('https://en.wikipedia.org/wiki/Special:Search/quantum_tunnelling')).toBe('quantum_tunnelling');
    expect(q('https://de.wikipedia.org/wiki/Spezial:Suche?search=Schwarzes+Loch')).toBe('Schwarzes Loch');
    expect(q('https://en.m.wikipedia.org/w/index.php?search=mobile+search')).toBe('mobile search');
    expect(findSearch('https://en.wikipedia.org/wiki/Photosynthesis')).toBeNull();
  });
});

describe('AI assistants, when the question is in the address', () => {
  it('reads ChatGPT', () => {
    expect(findSearch('https://chatgpt.com/?q=plan+a+4+day+workout+split&hints=search')).toMatchObject({ engine: 'chatgpt', query: 'plan a 4 day workout split', url: 'https://chatgpt.com/?q=plan%20a%204%20day%20workout%20split' });
    expect(q('https://chatgpt.com/?prompt=summarize+this')).toBe('summarize this');
    expect(q('https://chat.openai.com/?q=old+domain')).toBe('old domain');
    expect(findSearch('https://chatgpt.com/c/6710aa-1234-5678')).toBeNull();
    expect(findSearch('https://chatgpt.com/')).toBeNull();
  });

  it('reads Perplexity', () => {
    expect(findSearch('https://www.perplexity.ai/search?q=is+creatine+safe&copilot=false')).toMatchObject({ engine: 'perplexity', query: 'is creatine safe', url: 'https://www.perplexity.ai/search?q=is%20creatine%20safe' });
    expect(q('https://www.perplexity.ai/search/new?q=fresh+thread')).toBe('fresh thread');
    expect(q('https://perplexity.ai/?q=root')).toBe('root');
    // A thread's address is made from the question, but it isn't the question itself.
    expect(findSearch('https://www.perplexity.ai/search/is-creatine-safe-abc123XYZ')).toBeNull();
  });
});

describe('other search boxes', () => {
  it('reads them too', () => {
    const cases: [string, string, string][] = [
      ['https://www.ecosia.org/search?method=index&q=trees', 'ecosia', 'trees'],
      ['https://search.brave.com/search?q=brave+search&source=web', 'brave', 'brave search'],
      ['https://search.yahoo.com/search?p=yahoo+words&fr=yfp-t', 'yahoo', 'yahoo words'],
      ['https://kagi.com/search?q=kagi+words', 'kagi', 'kagi words'],
      ['https://www.startpage.com/do/search?query=start+page', 'startpage', 'start page'],
      ['https://yandex.ru/search/?text=%D0%BF%D0%BE%D0%B3%D0%BE%D0%B4%D0%B0&lr=213', 'yandex', 'погода'],
      ['https://www.baidu.com/s?wd=%E7%99%BE%E5%BA%A6', 'baidu', '百度'],
      ['https://x.com/search?q=%23fitness&src=typed_query', 'x', '#fitness'],
      ['https://twitter.com/search?q=old+bird', 'x', 'old bird'],
      ['https://www.tiktok.com/search?q=dance&t=1700000000000', 'tiktok', 'dance'],
      ['https://www.pinterest.com/search/pins/?q=home+gym&rs=typed', 'pinterest', 'home gym'],
      ['https://github.com/search?q=vitest+jsdom&type=repositories', 'github', 'vitest jsdom'],
      ['https://stackoverflow.com/search?q=async+await', 'stackoverflow', 'async await'],
      ['https://www.ebay.com/sch/i.html?_from=R40&_nkw=dumbbells&_sacat=0', 'ebay', 'dumbbells'],
      ['https://www.etsy.com/search?q=handmade+mug&ref=search_bar', 'etsy', 'handmade mug'],
      ['https://open.spotify.com/search/running%20mix', 'spotify', 'running mix'],
      ['https://www.netflix.com/search?q=dark', 'netflix', 'dark'],
      ['https://www.linkedin.com/search/results/all/?keywords=product+manager&origin=GLOBAL_SEARCH_HEADER', 'linkedin', 'product manager'],
    ];
    for (const [url, id, words] of cases) expect(findSearch(url), url).toMatchObject({ engine: id, query: words });
  });

  it('caps very long searches', () => {
    expect(q(`https://www.google.com/search?q=${'a'.repeat(1000)}`)!.length).toBe(300);
  });

  it('ignores addresses that are not web pages, or broken', () => {
    for (const url of ['', 'not a url', 'chrome://history/?q=x', 'file:///search?q=x', 'about:blank', 'javascript:alert(1)']) expect(findSearch(url), url).toBeNull();
    // Broken letters in the address don't break anything.
    expect(findSearch('https://www.google.com/search?q=%E0%A4%A')?.engine).toBe('google');
    expect(findSearch('https://open.spotify.com/search/%E0%A4%A')?.query).toBe('%E0%A4%A');
  });
});
