/**
 * 版本号唯一来源。
 *
 * 不从 package.json 读：插件是通过符号链接/安装副本运行的，
 * 那里的路径关系不一定成立，而且 package.json 可能被编辑器写进 BOM 导致 JSON.parse 失败。
 * 这里放常量，测试会断言它与 package.json 一致。
 */
export const VERSION = '0.5.1';
