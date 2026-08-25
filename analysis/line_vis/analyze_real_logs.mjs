import { readFileSync, writeFileSync } from 'fs';
import zlib from 'zlib';

function parseLog(path) {
  const txt = readFileSync(path, 'utf8');
  const grid = new Map();
  const re = /y=(\d+):\s*([\d,\s]+)/g;
  let m; let W = 0;
  while ((m = re.exec(txt))) {
    const y = parseInt(m[1], 10);
    const vals = m[2].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
    grid.set(y, vals);
    if (vals.length > W) W = vals.length;
  }
  const H = Math.max(...grid.keys()) + 1;
  const a = new Float32Array(W * H);
  for (const [y, vals] of grid) for (let x = 0; x < vals.length; x++) a[y * W + x] = vals[x];
  return { a, W, H };
}
const CRC = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xedb88320^(c>>>1)):(c>>>1);t[n]=c>>>0;} return (buf)=>{let c=0xffffffff;for(let i=0;i<buf.length;i++)c=t[(c^buf[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}; })();
function chunk(type, data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(CRC(Buffer.concat([t,data])),0);return Buffer.concat([len,t,data,crc]);}
function encodePNG(W,H,rgb){const sig=Buffer.from([137,80,78,71,13,10,26,10]);const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;const stride=W*3;const raw=Buffer.alloc((stride+1)*H);for(let y=0;y<H;y++){raw[y*(stride+1)]=0;rgb.copy(raw,y*(stride+1)+1,y*stride,y*stride+stride);}const idat=zlib.deflateSync(raw,{level:9});return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);}

function renderScaled(a, W, H, scale, mode, crop) {
  const [x0,y0,x1,y1] = crop || [0,0,W,H];
  const w = (x1-x0), h=(y1-y0);
  const rgb = Buffer.alloc(w*h*3*scale*scale);
  for (let yy=0; yy<h; yy++) for (let xx=0; xx<w; xx++) {
    const v = a[(y0+yy)*W+(x0+xx)];
    let r,g,b;
    if (mode==='gray'){ const c=v>16?40:255; r=g=b=c; }
    else if (mode==='prob'){
      // handled by caller-provided a as rgb index? we pass prebuilt
    }
    for(let sy=0;sy<scale;sy++)for(let sx=0;sx<scale;sx++){
      const idx=((yy*scale+sy)*w*scale+(xx*scale+sx))*3;
      rgb[idx]=r;rgb[idx+1]=g;rgb[idx+2]=b;
    }
  }
  return encodePNG(w*scale, h*scale, rgb);
}

const orig = parseLog('C:/Users/Administrator/Desktop/原始.log');
const sm = parseLog('C:/Users/Administrator/Desktop/平滑后.log');
const { W, H } = orig;

let oLine=0,sLine=0,loss=0,over=0;
let minX=W,maxX=0,minY=H,maxY=0;
const prob = new Float32Array(W*H*3); // store rgb
for (let y=0;y<H;y++)for(let x=0;x<W;x++){
  const o=orig.a[y*W+x]>16?1:0, s=sm.a[y*W+x]>16?1:0;
  if(o)oLine++; if(s)sLine++;
  let r=255,g=255,b=255;
  if(o&&!s){r=210;g=30;b=30;loss++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;}
  else if(!o&&s){r=30;g=90;b=230;over++;}
  else if(o&&s){r=55;g=55;b=55;}
  prob[(y*W+x)*3]=r;prob[(y*W+x)*3+1]=g;prob[(y*W+x)*3+2]=b;
}
console.log('orig line px:',oLine,' smoothed line px:',sLine,' loss:',loss,' overshoot:',over);
console.log('loss bbox x',minX,'-',maxX,' y',minY,'-',maxY);

// full 3x gray renders
writeFileSync('analysis/line_vis/real_orig_3x.png', renderScaled(orig.a,W,H,3,'gray'));
writeFileSync('analysis/line_vis/real_sm_3x.png', renderScaled(sm.a,W,H,3,'gray'));
writeFileSync('analysis/line_vis/real_prob_3x.png', renderScaled(prob,W,H,3,'prob'));
// cropped problem region (pad 15)
const pad=15;
const cx0=Math.max(0,minX-pad),cy0=Math.max(0,minY-pad),cx1=Math.min(W,maxX+pad),cy1=Math.min(H,maxY+pad);
writeFileSync('analysis/line_vis/real_prob_crop.png', renderScaled(prob,W,H,4,'prob',[cx0,cy0,cx1,cy1]));
writeFileSync('analysis/line_vis/real_orig_crop.png', renderScaled(orig.a,W,H,4,'gray',[cx0,cy0,cx1,cy1]));
writeFileSync('analysis/line_vis/real_sm_crop.png', renderScaled(sm.a,W,H,4,'gray',[cx0,cy0,cx1,cy1]));
console.log('crop',cx0,cy0,cx1,cy1);
