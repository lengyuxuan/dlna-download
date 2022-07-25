export function objToArr(obj: { [k: string]: any }): string[] {
  const list: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    list.push(k);
    list.push(Object.prototype.toString.call(v) === '[object Object]' ? JSON.stringify(v) : v);
  }
  return list;
}

export function arrToObj<T>(arr: string[]) {
  const obj = {};
  for (let i = 0; i < arr.length; i += 2) {
    obj[arr[i]] = arr[i + 1];
  }
  return obj as T;
}

export function parseM3u8(m3u8: string): { url: string, extinf: number }[] {
  m3u8 = m3u8.replace(/\r\n/g, '\n');
  const reg = /#EXTINF:(?<extinf>.+?),\n(?<url>.+?)\n/g;
  let result = null;
  const list = [];
  while (result = reg.exec(m3u8)) {
    list.push({
      url: result.groups.url,
      extinf: result.groups.extinf,
    });
  }
  return list;
}
