import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { globSync } from 'glob';
import { minify as jsMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier';
import JSZip from "jszip";
import obfs from 'javascript-obfuscator';
import pkg from '../package.json' with { type: 'json' };

const env = process.env.NODE_ENV || 'mangle';
const mangleMode = env === 'mangle';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

const ASSET_PATH = join(__dirname, '../src/assets');
const DIST_PATH = join(__dirname, '../dist/');

const green = '\x1b[32m';
const red = '\x1b[31m';
const reset = '\x1b[0m';

const success = `${green}✔${reset}`;
const failure = `${red}✔${reset}`;

const version = pkg.version;

async function processHtmlPages() {
    const indexFiles = globSync('**/index.html', { cwd: ASSET_PATH });
    const result = {};

    for (const relativeIndexPath of indexFiles) {
        const dir = pathDirname(relativeIndexPath);
        const base = (file) => join(ASSET_PATH, dir, file);

        const indexHtml = readFileSync(base('index.html'), 'utf8');
        let finalHtml = indexHtml.replaceAll('__VERSION__', version);

        if (dir !== 'error') {
            const styleCode = readFileSync(base('style.css'), 'utf8');
            const scriptCode = readFileSync(base('script.js'), 'utf8');
            const finalScriptCode = await jsMinify(scriptCode);
            finalHtml = finalHtml
                .replaceAll('__STYLE__', `<style>${styleCode}</style>`)
                .replaceAll('__SCRIPT__', finalScriptCode.code);
        }

        const minifiedHtml = htmlMinify(finalHtml, {
            collapseWhitespace: true,
            removeAttributeQuotes: true,
            minifyCSS: true
        });

        const encodedHtml = Buffer.from(minifiedHtml, 'utf8').toString('base64');
        result[dir] = JSON.stringify(encodedHtml);
    }

    console.log(`${success} Assets bundled successfuly!`);
    return result;
}

function generateJunkCode() {
    const minVars = 50, maxVars = 500;
    const minFuncs = 50, maxFuncs = 500;

    const varCount = Math.floor(Math.random() * (maxVars - minVars + 1)) + minVars;
    const funcCount = Math.floor(Math.random() * (maxFuncs - minFuncs + 1)) + minFuncs;

    const junkVars = Array.from({ length: varCount }, (_, i) => {
        const varName = `__junk_${Math.random().toString(36).substring(2, 10)}_${i}`;
        const value = Math.floor(Math.random() * 100000);
        return `let ${varName} = ${value};`;
    }).join('\n');

    const junkFuncs = Array.from({ length: funcCount }, (_, i) => {
        const funcName = `__junkFunc_${Math.random().toString(36).substring(2, 10)}_${i}`;
        return `function ${funcName}() { return ${Math.floor(Math.random() * 1000)}; }`;
    }).join('\n');

    return `${junkVars}\n${junkFuncs}\n`;
}

async function buildWorker() {

    const htmls = await processHtmlPages();
    const faviconBuffer = readFileSync('./src/assets/favicon.ico');
    const faviconBase64 = faviconBuffer.toString('base64');

    const code = await build({
        entryPoints: [join(__dirname, '../src/worker.js')],
        bundle: true,
        format: 'esm',
        write: false,
        external: ['cloudflare:sockets'],
        platform: 'browser',
        target: 'es2020',
        define: {
            __PANEL_HTML_CONTENT__: htmls['panel'] ?? '""',
            __LOGIN_HTML_CONTENT__: htmls['login'] ?? '""',
            __ERROR_HTML_CONTENT__: htmls['error'] ?? '""',
            __SECRETS_HTML_CONTENT__: htmls['secrets'] ?? '""',
            __ICON__: JSON.stringify(faviconBase64),
            __VERSION__: JSON.stringify(version)
        }
    });

    console.log(`${success} Worker built successfuly!`);

    const minifyCode = async (code) => {
        const minified = await jsMinify(code, {
            module: true,
            output: {
                comments: false
            },
            compress: {
                dead_code: false,
                unused: false
            }
        });

        console.log(`${success} Worker minified successfuly!`);
        return minified;
    }

    let finalCode;

    if (mangleMode) {
        const junkCode = generateJunkCode();
        const minifiedCode = await minifyCode(junkCode + code.outputFiles[0].text);
        finalCode = minifiedCode.code;
    } else {
        const minifiedCode = await minifyCode(code.outputFiles[0].text);
        const obfuscationResult = obfs.obfuscate(minifiedCode.code, {
            // 字符串加密和隐藏
            stringArray: true,
            stringArrayEncoding: [
                "rc4"
            ],
            stringArrayThreshold: 1,
            stringArrayWrappersCount: 2,
            stringArrayWrappersChainedCalls: true,
            stringArrayWrappersType: "function",
            stringArrayRotate: true,
            stringArrayShuffle: true,
            
            // 控制流保护 (适度使用以避免1101错误)
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.3, // 进一步降低阈值以减少错误
            
            // 死代码注入
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.1, // 进一步降低阈值以减少错误
            
            // 标识符混淆
            renameGlobals: true,
            // renameProperties: true, // 暂时禁用属性重命名以避免1101错误
            renamePropertiesMode: "safe",
            
            // 其他混淆技术
            numbersToExpressions: true,
            transformObjectKeys: true,
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 5, // 减少块长度以提高兼容性
            
            // 域名保护
            domainLock: [],
            
            // 调试保护 (适度使用以避免1101错误)
            debugProtection: false, // 禁用调试保护以避免1101错误
            debugProtectionInterval: false,
            
            // 自我保护
            selfDefending: true,
            
            // 严格模式
            strict: false, // 禁用严格模式以提高兼容性
            
            // 目标环境
            target: "browser-no-eval" // 使用更安全的目标环境以避免eval相关错误
        });

        console.log(`${success} Worker obfuscated successfuly!`);
        finalCode = obfuscationResult.getObfuscatedCode();
    }

    const buildTimestamp = new Date().toISOString();
    const buildInfo = `// Build: ${buildTimestamp}\n`;
    const worker = `${buildInfo}// @ts-nocheck\n${finalCode}`;
    mkdirSync(DIST_PATH, { recursive: true });
    writeFileSync('./dist/worker.js', worker, 'utf8');

    const zip = new JSZip();
    zip.file('_worker.js', worker);
    zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE'
    }).then(nodebuffer => writeFileSync('./dist/worker.zip', nodebuffer));

    console.log(`${success} Done!`);
}

buildWorker().catch(err => {
    console.error(`${failure} Build failed:`, err);
    process.exit(1);
});
