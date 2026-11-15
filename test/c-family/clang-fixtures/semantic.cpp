#define APPLY(fn, value) fn(value)
int target(int value) { return value; }
int through_macro(int value) { return APPLY(target, value); }
int through_pointer(int (*function)(int), int value) { return function(value); }
template<class T> class Box { public: T get(T value) { return value; } };
int run(int value) {
    Box<int> box;
    auto lambda = [](int offset) { return target(offset + 1); };
    if(value > 0) return lambda(through_pointer(target, value));
    return box.get(value);
}
int sum(void) {
    int values[3] = {1,2,3};
    int result = 0;
    for(int value : values) result += target(value);
    return result;
}
int guarded(int value) {
    try { if(value) throw value; return target(value); }
    catch(int error) { return target(error); }
    catch(...) { return 0; }
}
struct Initialized { int member; Initialized(int value); template<class T> Initialized(T value): member(target((int)value)) {} };
auto trailing_return(int value) -> int { return value; }
Initialized::Initialized(int value): member(target(value)) {}

int condition_input();
int while_declaration() { while (int value = condition_input()) { if (value > 3) break; } return 0; }
int for_declaration() { for (; int value = condition_input(); ) { if (value > 3) break; } return 0; }
