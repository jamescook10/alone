// All world materials. Flat-shaded Lambert throughout: solid vertex colours,
// faceted normals from screen-space derivatives, no texture sets and no PBR.
// The only texture left is a generated noise map used as a noise source for
// the sky's stars and the water's foam.

import * as THREE from 'three';
import { atmo, injectAtmosphere, ATMO_PARS, WIND_PARS } from './atmosphere.js';
import { Noise } from '../core/noise.js';

/* ---------------------------------------------------------- textures */

let _detailTex = null;
export function detailTexture() {
  if (_detailTex) return _detailTex;
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  const n1 = new Noise(11);
  const n2 = new Noise(29);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      // tileable-ish fbm by sampling on a torus
      const a = (x / S) * Math.PI * 2;
      const b = (y / S) * Math.PI * 2;
      const tx = Math.cos(a) * 6,
        ty = Math.sin(a) * 6,
        tz = Math.cos(b) * 6,
        tw = Math.sin(b) * 6;
      const v = n1.fbm3(tx, ty, tz + tw * 0.5, 4) * 0.5 + 0.5;
      const w = n2.fbm3(tx * 2.4 + 10, tz * 2.4, ty * 2.4 - tw, 3) * 0.5 + 0.5;
      data[i] = v * 255;
      data[i + 1] = w * 255;
      data[i + 2] = (v * w) * 255;
      data[i + 3] = 255;
    }
  }
  _detailTex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  _detailTex.wrapS = _detailTex.wrapT = THREE.RepeatWrapping;
  _detailTex.needsUpdate = true;
  _detailTex.generateMipmaps = true;
  _detailTex.minFilter = THREE.LinearMipmapLinearFilter;
  _detailTex.magFilter = THREE.LinearFilter;
  return _detailTex;
}

/** Soft round alpha sprite, used for particles. */
export function blobTexture(softness = 0.55, seed = 3) {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(softness, 'rgba(255,255,255,0.75)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------------------------------------------------- terrain */

// The colour a forest canopy takes seen from above: near-black blue-green in
// cold conifer country, a warmer green where broadleaf grows. Authored in
// sRGB and converted once, like every other reflectance in the game.
// Deliberately much darker than the ground they sit on. Measured, the first
// version differed from forest ground by only 16-19 sRGB levels, which reads
// as a faint stain rather than as woodland; a real canopy seen from the air is
// roughly half the luminance of open pasture.
const CANOPY_COLD = new THREE.Color().setRGB(0.13, 0.22, 0.17, THREE.SRGBColorSpace);
const CANOPY_WARM = new THREE.Color().setRGB(0.19, 0.32, 0.17, THREE.SRGBColorSpace);
const v3 = (c) => `vec3( ${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)} )`;

export function makeTerrainMaterial() {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    // Faceted normals from derivatives: every terrain triangle reads as one
    // flat plane, which is the whole look - and it makes the worker's smooth
    // normals irrelevant to lighting.
    flatShading: true,
  });
  injectAtmosphere(mat, {
    key: 'terrain',
    // The worker already baked climate snow into the vertex colours using the
    // true local temperature, so the shared shader term would double it.
    snow: false,
    vertexPars: /* glsl */ `
      attribute vec4 aux;
      varying vec4 vAux;
    `,
    vertexBody: `vAux = aux;`,
    fragmentPars: /* glsl */ `
      uniform float uWetness;
      uniform float uRain;
      uniform float uTime;
      uniform float uWaterY;
      uniform float uSnowAmount;
      uniform float uClimateTemp;
      varying vec4 vAux;
      // Puddle mask, written by the colour stage and read by the emissive
      // stage - the sky a puddle reflects must not be multiplied by the
      // ground's own lighting, or it goes black in shadow.
      float gPuddle = 0.0;

      // Value noise on floats only. The CPU's hash3f cannot be ported here as
      // it stands: its constants exceed INT_MAX, and an out-of-range integer
      // literal is an error in GLSL ES 3.00. This never has to agree with the
      // CPU - nothing else reads it - so a float hash is the safe choice.
      float chash( vec2 p ) {
        return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
      }
      float cnoise( vec2 p ) {
        vec2 i = floor( p );
        vec2 f = fract( p );
        vec2 u = f * f * ( 3.0 - 2.0 * f );
        return mix(
          mix( chash( i ), chash( i + vec2( 1.0, 0.0 ) ), u.x ),
          mix( chash( i + vec2( 0.0, 1.0 ) ), chash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
      }
    `,
    colorFragment: /* glsl */ `
      {
        // Rain darkens the ground; puddled shorelines (vAux.x) stay darker.
        float wet = clamp( vAux.x + uWetness * ( 1.0 - vAux.y * 1.6 ), 0.0, 1.0 );
        diffuseColor.rgb *= mix( 1.0, 0.72, wet * 0.8 );

        // Painted forest canopy, faded in by camera distance.
        //
        // Instanced trees stop about 2.5 km out, so past that a wooded hill has
        // to be painted. vAux.z carries the smooth cover fraction; every scrap
        // of STRUCTURE is generated here, per pixel.
        //
        // That split is the whole point. The first version baked the mottle
        // into the vertices, and the vertex spacing that samples it runs from
        // 4 m near to 43 m at lod 3 and 368 m on the horizon ring - so it
        // averaged away to a flat wash exactly where it was needed. Measured,
        // it delivered a mean of -21/255 green with a spatial deviation of 5,
        // which does not read as forest: a lerp toward one colour pulls the
        // clearings down as hard as it darkens the wood, and it actually CUT
        // frame contrast from 15.7 to 12.2. A threshold mask cannot do that -
        // it leaves the clearings alone and only darkens where trees stand.
        float cd = distance( vWorldPos, cameraPosition );
        // Starts well inside the instanced ring on purpose. Where real trees are
          // drawn this reads as the shade they cast on the ground; where they
          // have thinned out it takes over as the trees themselves. Beginning it
          // at the far ring instead left a visibly paler band around the player.
          float canopy = vAux.z * smoothstep( 150.0, 620.0, cd );
        if ( canopy > 0.002 ) {
          vec2 wp = vWorldPos.xz;
          // Stands, then clumps within a stand, then individual crowns. The
          // finest octave fades out past 3 km, where it would alias.
          float n = cnoise( wp * 0.0045 ) * 0.55
                  + cnoise( wp * 0.019 ) * 0.28
                  + cnoise( wp * 0.075 ) * 0.17 * ( 1.0 - smoothstep( 1200.0, 3000.0, cd ) );
          // A mask, not a wash: below the threshold the ground stays exactly
          // as it was, so clearings, tracks and rock keep their own colour.
          float m = smoothstep( 0.52 - canopy * 0.62, 0.92 - canopy * 0.62, n );
          float ct = uClimateTemp - max( vWorldPos.y, 0.0 ) * 0.0068;
          vec3 cc = mix( ${v3(CANOPY_COLD)}, ${v3(CANOPY_WARM)}, smoothstep( 3.0, 13.0, ct ) );
          // Sunlit crowns against shaded gaps. Without this the mask is still
          // a flat colour, just a lumpy one - and it is the light falling on
          // one side of a wood that says "trees" at four kilometres.
          float lit = 0.5 + 0.5 * dot( normalize( vec3(
            cnoise( wp * 0.019 + 7.3 ) - n, 0.55, cnoise( wp * 0.019 - 3.1 ) - n ) ), uSunDir );
          cc *= 0.80 + 0.55 * lit;
          diffuseColor.rgb = mix( diffuseColor.rgb, cc, m * min( 1.0, canopy * 1.55 ) );
        }

        // Fresh snowfall whitens flat ground.
        float snow = clamp( uSnowAmount * ( 1.0 - vAux.y * 1.3 ), 0.0, 1.0 );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.89, 0.94 ), snow * 0.9 );

        // Puddles. Wet weather pools standing water in the hollows of flat
        // ground: a noise mask whose threshold sinks as the ground soaks, so
        // a shower leaves a few dark mirrors and a long storm floods the
        // whole path - then they dry off as uWetness decays. Only near the
        // camera: past a couple hundred metres a puddle is sub-pixel and the
        // wet-ground darkening already carries the look.
        float pd = distance( vWorldPos.xz, cameraPosition.xz );
        if ( uWetness > 0.12 && vAux.y < 0.05 && snow < 0.5 && pd < 260.0 ) {
          vec2 wp2 = vWorldPos.xz;
          // Two octaves of value noise concentrate hard around 0.5 - a
          // threshold up at 0.7+ almost never fires. These sit inside the
          // real spread: light wetness picks off the deepest hollows, a
          // soaked field floods about a third of the flat ground.
          float pn = cnoise( wp2 * 0.31 ) * 0.55 + cnoise( wp2 * 0.071 ) * 0.45;
          float th = 0.78 - uWetness * 0.30;
          float pud = smoothstep( th, th + 0.07, pn )
            * ( 1.0 - smoothstep( 0.015, 0.05, vAux.y ) )
            * ( 1.0 - snow ) * ( 1.0 - smoothstep( 180.0, 260.0, pd ) );
          // The ground under a puddle is drowned dark; what you see is sky,
          // and that arrives through the emissive stage below.
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 0.22, pud );
          gPuddle = pud;
        }
      }
    `,
    emissiveFragment: /* glsl */ `
      {
        // Caustics. Sunlight refracted through a rippled surface focuses into
        // a moving web on whatever is underneath it, and its absence is most
        // of why shallow water read as a flat pane laid over the ground.
        // uWaterY is the surface height of the nearest water, so the ground
        // can work out its own depth without carrying one per vertex.
        // vAux.x is the per-vertex submersion the worker baked: 0.5 exactly at
        // the waterline and above it underneath. uWaterY alone is a single
        // number for the whole frame, so on its own it painted caustics onto
        // every dry field in view that happened to lie below the height of a
        // pond half a mile away. The mask says WHETHER, the uniform says how
        // deep.
        float submerged = smoothstep( 0.52, 0.78, vAux.x );
        float sub = uWaterY - vWorldPos.y;
        if ( submerged > 0.01 && sub > 0.02 && sub < 26.0 && uSunDir.y > 0.02 ) {
          vec2 cp = vWorldPos.xz;
          float ct = uTime * 0.5;
          // Two counter-drifting ridged layers. Where their crests cross you
          // get the bright knot; the high power is what makes it a web of
          // thin lines instead of a wash.
          // Roughly half-metre cells. The first pass ran an octave lower and
          // the web came out as metre-and-a-half blobs that filled the screen
          // when you stood over a pool and read as a stain, not as light.
          float c1 = 1.0 - abs( cnoise( cp * 2.3 + vec2( ct * 0.33, -ct * 0.21 ) ) * 2.0 - 1.0 );
          float c2 = 1.0 - abs( cnoise( cp * 3.5 - vec2( ct * 0.25, ct * 0.29 ) ) * 2.0 - 1.0 );
          float caus = pow( clamp( c1 * c2, 0.0, 1.0 ), 4.0 );
          // Brightest just under the surface and gone once the light has been
          // scattered out of the beam. Faded out with distance as well, or the
          // web aliases into a shimmer across a whole lake.
          float k = submerged * smoothstep( 0.0, 0.45, sub ) * ( 1.0 - smoothstep( 3.5, 24.0, sub ) )
            * ( 1.0 - smoothstep( 45.0, 130.0, distance( vWorldPos, cameraPosition ) ) );
          totalEmissiveRadiance += uSunColor * caus * k * 0.85 * uSunDir.y;
        }
      }
      if ( gPuddle > 0.002 ) {
        // Falling rain keeps a puddle shivering; still air leaves it a mirror.
        vec2 wp2 = vWorldPos.xz;
        float rip = ( cnoise( wp2 * 1.9 + vec2( uTime * 1.4, -uTime * 1.1 ) ) - 0.5 ) * uRain;
        vec3 pN = normalize( vec3( rip * 0.55, 1.0, rip * 0.45 ) );
        vec3 pV = normalize( cameraPosition - vWorldPos );
        // Sky standing in for reflection, the same stops the water uses, plus
        // a sun glint off the (rain-ruffled) surface.
        vec3 skyRef = mix( uHorizonColor, uZenithColor, 0.35 );
        // Weak looked at steeply - you mostly see the drowned ground - and
        // bright at a grazing angle, like the real thing. A flat 0.35 base
        // made every puddle read as lying snow.
        float pFres = 0.16 + 0.74 * pow( 1.0 - clamp( dot( pN, pV ), 0.0, 1.0 ), 2.0 );
        vec3 pH = normalize( uSunDir + pV );
        float pSpec = pow( max( dot( pN, pH ), 0.0 ), 180.0 );
        totalEmissiveRadiance += ( skyRef * pFres + uSunColor * pSpec * 0.9 ) * gPuddle;
      }
    `,
  });
  return mat;
}

/* ------------------------------------------------------------ water */

// Shared between the vertex shader and World.waveHeightAt - if these drift
// apart, the player stops bobbing on the swell they can see.
export const GERSTNER_WAVES = [
  // dirX, dirZ, wavelength (m), amplitude (m), steepness
  [0.80, 0.60, 46, 0.40, 0.34],
  [-0.55, 0.83, 27, 0.22, 0.40],
  [0.20, -0.98, 13, 0.10, 0.46],
  [0.95, -0.31, 6.5, 0.045, 0.50],
];

const GERSTNER_GLSL = GERSTNER_WAVES.map(([dx, dz, L, A, Q], i) => {
  const k = (Math.PI * 2) / L;
  const w = Math.sqrt(9.81 * k);
  const il = 1 / Math.hypot(dx, dz);
  return `
    {
      vec2 D = vec2( ${(dx * il).toFixed(4)}, ${(dz * il).toFixed(4)} );
      float kk = ${k.toFixed(5)};
      float A = ${A.toFixed(3)} * amp;
      float ph = kk * dot( D, p0 ) + ${w.toFixed(4)} * uTime;
      float ca = cos( ph ), sa = sin( ph );
      wp.xz -= D * ( ${Q.toFixed(2)} * A * ca );
      wp.y += A * sa;
      crest += sa * ${(A / 0.765).toFixed(3)};
    }`;
}).join('\n');

const WATER_VERT = /* glsl */ `
  attribute vec2 flow;
  attribute float depth;
  attribute float fall;
  uniform float uTime;
  uniform float uWaveScale;
  uniform float uWindStrength;
  varying vec3 vWorldPos;
  varying vec2 vFlow;
  varying float vDepth;
  varying float vCrest;
  varying float vFall;

  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vFlow = flow;
    vDepth = depth;
    vFall = fall;
    // Waves flatten in the shallows and in rivers, and the sea state follows
    // the wind: glass at dawn, whitecaps in a storm.
    //
    // Running water is flagged by having any flow at all, NOT by how fast it
    // is going. Damping on speed looks equivalent and is not: once river
    // speed came off the channel gradient rather than off "am I in a river",
    // every placid river in the world stopped being damped and grew a half
    // metre of ocean swell, which at a bank read as a strip of choppy silver.
    float shore = clamp( depth / 2.5, 0.0, 1.0 );
    float running = step( 0.01, length( flow ) );
    float amp = uWaveScale * shore * ( 1.0 - running * 0.86 )
      * ( 0.45 + clamp( uWindStrength, 0.0, 1.5 ) * 0.75 );
    vec2 p0 = wp.xz;
    float crest = 0.0;
    ${'${GERSTNER}'}
    vCrest = crest;
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`.replace('${GERSTNER}', GERSTNER_GLSL);

const WATER_FRAG = /* glsl */ `
  precision highp float;
  ${ATMO_PARS}
  uniform sampler2D tDetail;
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform float uWindStrength;
  uniform float uRain;
  uniform float uWade;
  // ATMO_PARS does not declare this one, and a ShaderMaterial gets no
  // automatic declarations the way a patched built-in material does. Using it
  // undeclared failed the whole water program to compile, and a failed
  // program draws nothing at all - so every lake and river in the world went
  // invisible while the lit riverbed underneath went on looking convincing
  // enough to send me hunting for a foam bug that was never there.
  uniform vec3 uPlayerPos;
  varying vec2 vFlow;
  varying float vDepth;
  varying float vCrest;
  varying float vFall;

  float whash( vec2 p ) {
    return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
  }

  void main() {
    vec3 dv = cameraPosition - vWorldPos;
    float vdist = length( dv );
    vec3 V = dv / max( vdist, 1e-4 );
    vec2 p = vWorldPos.xz;
    // Foam flecks and facet glints are sub-pixel past a few hundred metres,
    // where they alias into white noise crawling over the whole sea - worst
    // from the aeroplane. Distance keeps the body colour and the fresnel and
    // lets the glitter live only where it can resolve.
    float farK = 1.0 - smoothstep( 350.0, 1100.0, vdist );

    // Faceted normal straight from the displaced surface: every triangle of
    // the swell is one flat mirror shard, which is what makes Gerstner waves
    // look hand-made instead of simulated.
    vec3 N = normalize( cross( dFdx( vWorldPos ), dFdy( vWorldPos ) ) );
    if ( dot( N, V ) < 0.0 ) N = -N;
    float ndv = abs( dot( N, V ) );

    // How hard the channel is dropping, straight off the traced gradient.
    // This is deliberately NOT read from the surface normal: on a displaced
    // Gerstner mesh the derivative normal tips about on every wavelet, and
    // deriving white water from it - or from flow speed, which a placid river
    // also has - painted every river in the world boiling silver.
    float chute = smoothstep( 0.22, 0.75, vFall );

    // Body colour by how far light has had to travel through it. An
    // exponential is the honest curve and it matters: the old linear ramp hit
    // near-opaque at a metre and a half, so every brook and every shallow was
    // a flat slab of blue-green with the bed it was standing on invisible
    // underneath. Water a few inches deep should show you the gravel.
    float clarity = 3.4;
    float opt = 1.0 - exp( -vDepth / clarity );
    vec3 body = mix( uShallow, uDeep, opt );
    float fres = pow( 1.0 - clamp( ndv, 0.0, 1.0 ), 3.0 );
    vec3 col = mix( body, uHorizonColor, 0.10 + fres * 0.60 );

    // Sun sparkle off the facets - dulled while rain roughens the surface.
    vec3 H = normalize( uSunDir + V );
    float spec = pow( max( dot( N, H ), 0.0 ), 140.0 );
    col += uSunColor * spec * 1.6 * ( 0.12 + 0.88 * farK ) * ( 1.0 - uRain * 0.55 );

    // Foam: shoreline wash, river churn, and wind-torn whitecaps on crests.
    // Thresholds sit high so foam stays a ribbon at the water's edge and a
    // fleck on the crests - a low threshold painted every shallow in white.
    float speed = length( vFlow );
    vec2 adv = vFlow * uTime * 0.55;
    // The waterline is not a fixed contour: a wave runs up the sand and
    // drains back off it. The phase runs along the shore so the whole coast
    // does not breathe in unison.
    float surge = sin( uTime * 0.5 + ( p.x + p.y ) * 0.021 ) * 0.5 + 0.5;
    float shoreFoam = smoothstep( 0.35 + surge * 0.75, 0.02, vDepth );
    float churn = smoothstep( 0.95, 1.8, speed );
    float fn = texture2D( tDetail, p * 0.045 - adv * 0.08 + vec2( uTime * 0.02, 0.0 ) ).r;
    float fn2 = texture2D( tDetail, p * 0.11 + adv * 0.03 ).g;
    float whitecap = smoothstep( 0.80, 1.10, vCrest ) * smoothstep( 0.6, 1.3, uWindStrength );
    float foam = shoreFoam * smoothstep( 0.58, 0.78, fn )
      + churn * smoothstep( 0.55, 0.85, fn2 ) * 0.85
      + whitecap * smoothstep( 0.55, 0.80, fn2 );
    // Hard-edged foam patches, not a soft wash: quantising the mask keeps it
    // in the same graphic language as the flat facets. The grazing-angle fade
    // is what stops the speckle crawling along the shoreline as you turn:
    // a world-space texture read at a glancing angle aliases however far away
    // it is, so distance alone was never enough to hide it.
    foam = smoothstep( 0.34, 0.48, foam ) * farK * smoothstep( 0.02, 0.20, ndv );
    col = mix( col, vec3( 0.97, 0.99, 1.0 ), clamp( foam, 0.0, 0.9 ) );

    // White water. Anywhere the surface is falling steeply, or moving fast
    // over a broken bed, the water is full of air and stops being a mirror.
    if ( chute > 0.01 ) {
      // Fast water over a steepening bed breaks up before it actually falls,
      // so speed adds to a gradient that is already there - it never starts
      // white water on its own.
      float rapids = chute * ( 0.55 + 0.45 * smoothstep( 0.6, 1.8, speed ) );
      // Torn downward, fast, so a fall reads as moving rather than painted.
      float wn = texture2D( tDetail, p * vec2( 0.5, 0.16 ) + vec2( 0.0, -uTime * 1.3 ) ).r;
      float wn2 = texture2D( tDetail, p * 0.9 - vec2( 0.0, uTime * 2.1 ) ).g;
      float white = clamp( rapids, 0.0, 1.0 ) * ( 0.45 + 0.75 * wn * wn2 * 2.0 );
      col = mix( col, vec3( 0.95, 0.98, 1.0 ), clamp( white, 0.0, 0.94 ) * farK );
      foam = max( foam, clamp( white, 0.0, 0.9 ) * 0.8 );
    }

    // Rain rings. Every drop that lands throws a ring that expands and dies,
    // which is what rain on water actually looks like - the earlier version
    // was a stipple that boiled in place and read as static.
    if ( uRain > 0.02 && farK > 0.01 ) {
      vec2 rp = p * 1.25;
      vec2 ci = floor( rp );
      vec2 cf = fract( rp ) - 0.5;
      float rh = whash( ci );
      float ph = fract( uTime * 1.7 + rh * 11.0 );
      float rad = ph * 0.44;
      float d = length( cf );
      float ring = smoothstep( rad, rad - 0.07, d ) * smoothstep( rad - 0.15, rad - 0.06, d );
      ring *= ( 1.0 - ph ) * step( rh, uRain * 0.85 );
      col = mix( col, vec3( 0.88, 0.93, 0.97 ), clamp( ring, 0.0, 1.0 ) * 0.55 * farK );
    }

    // Rings spreading from someone standing in it.
    if ( uWade > 0.01 ) {
      float pd = distance( p, uPlayerPos.xz );
      float w = sin( pd * 2.6 - uTime * 5.5 ) * exp( -pd * 0.5 ) * uWade;
      col += vec3( 0.05, 0.06, 0.06 ) * w;
    }

    // Opacity follows the same extinction as the colour, so the bed shows
    // through the shallows and only real depth hides it.
    float alpha = clamp( opt * 0.94 + fres * 0.26 + foam * 0.7 + chute * 0.45, 0.05, 1.0 );

    if ( uUnderwater > 0.5 ) {
      // Seen from below the surface is a shifting mirror.
      col = mix( uWaterFog * 1.6, uHorizonColor, 0.35 );
      col += uSunColor * spec * 1.2;
      alpha = 0.55;
    }

    vec3 outCol = atmoApply( col, vWorldPos, cameraPosition );
    gl_FragColor = vec4( outCol, alpha );
  }
`;

export function makeWaterMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: Object.assign({}, atmo, {
      tDetail: { value: detailTexture() },
      uDeep: { value: new THREE.Color().setRGB(0.09, 0.29, 0.42, THREE.SRGBColorSpace) },
      uShallow: { value: new THREE.Color().setRGB(0.36, 0.71, 0.66, THREE.SRGBColorSpace) },
      uWaveScale: { value: 1.0 },
    }),
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return mat;
}

/* ---------------------------------------------------------- foliage */

/**
 * Vegetation: flat-shaded Lambert plus wind, with a hook for per-instance
 * tint and for the seasonal / burnt colour shifts the simulation applies.
 */
export function makeFoliageMaterial(opts = {}) {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  injectAtmosphere(mat, {
    key: 'foliage' + (opts.key || ''),
    // Snow on leaves and branches comes from the shared climate term now, so
    // a spruce standing in a snowfield is white whether or not it is snowing.
    vertexPars: WIND_PARS,
    vertexBody: /* glsl */ `
      {
        vec3 origin = vec3( 0.0 );
        #ifdef USE_INSTANCING
          origin = vec3( instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2] );
        #endif
        origin += vec3( modelMatrix[3][0], modelMatrix[3][1], modelMatrix[3][2] );
        transformed = windSway( transformed, origin, ${(opts.stiffness || 0.22).toFixed(3)}, ${(opts.sway || 1.0).toFixed(3)} );
      }
    `,
    // Leaves are thin: looking through a canopy toward the sun should glow.
    // uSunColor already carries the sky's brightness, so this fades itself out
    // at night and under overcast without any extra bookkeeping.
    emissiveFragment: opts.translucency
      ? /* glsl */ `
      {
        vec3 tV = normalize( cameraPosition - vWorldPos );
        float back = pow( clamp( dot( -tV, uSunDir ), 0.0, 1.0 ), 3.0 );
        totalEmissiveRadiance += diffuseColor.rgb * uSunColor * back * ${opts.translucency.toFixed(2)};
      }
    `
      : '',
  });
  return mat;
}

/** Flat-shaded solid material for rocks, buildings, vehicles and props. */
export function makeSolidMaterial(opts = {}) {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: opts.vertexColors !== false,
    color: opts.color !== undefined ? opts.color : 0xffffff,
    flatShading: opts.flat !== false,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity !== undefined ? opts.opacity : 1,
    emissive: opts.emissive !== undefined ? opts.emissive : 0x000000,
    emissiveIntensity: opts.emissiveIntensity !== undefined ? opts.emissiveIntensity : 1,
  });
  injectAtmosphere(mat, { key: 'solid' + (opts.key || '') });
  return mat;
}

/** Additive, unlit material for fire, sparks, glow and light shafts. */
export function makeGlowMaterial(map, color = 0xffffff) {
  return new THREE.MeshBasicMaterial({
    map: map || null,
    color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
}
