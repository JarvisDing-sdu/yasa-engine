#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 场景 1：命令注入 — 环境变量流向 system() */
void test_command_injection() {
    char *cmd = getenv("USER_CMD");
    system(cmd);
}

/* 场景 2：格式化字符串 — fgets 读入直接传给 printf */
void test_format_string() {
    char buf[256];
    fgets(buf, sizeof(buf), stdin);
    printf(buf);
}

/* 场景 3：缓冲区溢出 — recv 收到的数据传给 memcpy，无长度检查 */
void test_buffer_overflow(char *dest, int sock) {
    char src[1024];
    recv(sock, src, sizeof(src), 0);
    memcpy(dest, src, sizeof(src));
}

/* 场景 4：命令注入 — getenv → execl（exec 家族不同成员） */
void test_exec_family() {
    char *path = getenv("PATH");
    execl(path, "prog", NULL);
}

int main() {
    test_command_injection();
    test_format_string();
    return 0;
}
