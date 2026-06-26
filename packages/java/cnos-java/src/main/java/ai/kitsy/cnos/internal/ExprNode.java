package ai.kitsy.cnos.internal;

import java.util.Collections;
import java.util.List;

/**
 * AST node for the derive expression language.
 * Kinds: {@code literal}, {@code ref}, {@code call}.
 */
public final class ExprNode {

    private final String kind;
    private final Object value;   // literal value (literal nodes)
    private final String path;    // key path (ref nodes)
    private final String name;    // function name (call nodes)
    private final List<ExprNode> args; // arguments (call nodes)

    private ExprNode(String kind, Object value, String path, String name, List<ExprNode> args) {
        this.kind = kind;
        this.value = value;
        this.path = path;
        this.name = name;
        this.args = args != null ? Collections.unmodifiableList(args) : Collections.emptyList();
    }

    public static ExprNode literal(Object value) {
        return new ExprNode("literal", value, null, null, null);
    }

    public static ExprNode ref(String path) {
        return new ExprNode("ref", null, path, null, null);
    }

    public static ExprNode call(String name, List<ExprNode> args) {
        return new ExprNode("call", null, null, name, args);
    }

    public String getKind() { return kind; }
    public Object getValue() { return value; }
    public String getPath() { return path; }
    public String getName() { return name; }
    public List<ExprNode> getArgs() { return args; }
}
